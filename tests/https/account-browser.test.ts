import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { chromium, expect as pwExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

/**
 * Real browser against the actual controller in better-auth mode, behind the
 * fixture Caddy on a realistic isolated secure origin. The fixture CA, the
 * `switcher.localhost` mapping and the WebAuthn virtual authenticator are
 * test-only; the controller, provider, cookies and GUI are the real artifacts.
 */
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const caddyBinary = process.env.CADDY_BIN!;
const ownerPassword = "fixture-private-gui-owner-password-123";
const readerPassword = "fixture-private-gui-reader-password-123";
const operatorPassword = "fixture-private-gui-operator-password-123";
const recoveredPassword = "fixture-private-gui-recovered-password-456";
const ownerEmail = "owner@fixture.invalid";
const readerEmail = "reader@fixture.invalid";
const operatorEmail = "operator@fixture.invalid";

interface RunningProcess { child: ChildProcess; output(): string }

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a fixture port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolveProbe(open); };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function startProcess(executable: string, args: string[], environment: NodeJS.ProcessEnv): RunningProcess {
  let output = "";
  const child = spawn(executable, args, { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", chunk => { output += chunk.toString(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function stopProcess(process: RunningProcess | null): Promise<void> {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  await waitFor(() => process.child.exitCode !== null || process.child.signalCode !== null ? true : null, 15_000, () => "Fixture process did not stop.");
}

async function createCertificateAuthority(directory: string): Promise<{ certificate: string; key: string }> {
  const certificate = join(directory, "fixture-ca.crt");
  const key = join(directory, "fixture-ca.key");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", certificate, "-days", "2", "-sha256", "-subj", "/CN=Worktree Control Account Fixture CA",
  ]);
  return { certificate, key };
}

async function createServerCertificate(directory: string, ca: { certificate: string; key: string }): Promise<{ certificate: string; key: string }> {
  const certificate = join(directory, "server.crt");
  const key = join(directory, "server.key");
  const request = join(directory, "server.csr");
  const extensions = join(directory, "server.ext");
  await writeFile(extensions, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:switcher.localhost\n");
  await execFileAsync("openssl", [
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", request, "-sha256", "-subj", "/CN=switcher.localhost",
  ]);
  await execFileAsync("openssl", [
    "x509", "-req", "-in", request, "-CA", ca.certificate, "-CAkey", ca.key,
    "-set_serial", "201", "-out", certificate, "-days", "2", "-sha256", "-extfile", extensions,
  ]);
  return { certificate, key };
}

function caddyfile(options: { publicPort: number; backendPort: number; certificate: string; key: string }): string {
  return `{
  admin off
  auto_https disable_redirects
}

https://switcher.localhost:${options.publicPort} {
  tls ${options.certificate} ${options.key}
  reverse_proxy 127.0.0.1:${options.backendPort} {
    # The account transport pins the exact authority, port included; {host} alone strips it.
    header_up Host {http.request.hostport}
  }
}
`;
}

/** RFC 6238 (SHA-1, 6 digits, 30 s step) for the otpauth URI the enrollment shows. */
function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let held = 0;
  const out: number[] = [];
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base32 secret.");
    held = (held << 5) | digit;
    bits += 5;
    if (bits >= 8) { out.push((held >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * The controller consumes one TOTP step per subject and refuses reuse, so every
 * fill presents a strictly newer window with enough room to never straddle a
 * boundary between the fill and the server's verification.
 */
let lastTotpWindow = -1;
async function fillFreshTotp(page: Page, secret: string): Promise<void> {
  for (;;) {
    const now = Date.now(), window = Math.floor(now / 30_000), remain = 30_000 - (now % 30_000);
    if (window > lastTotpWindow && remain > 3_000) {
      lastTotpWindow = window;
      await page.getByLabel("TOTP code").fill(totpCode(secret, now));
      return;
    }
    await page.waitForTimeout(Math.min(remain + 250, 5_000));
  }
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
}

describe("account GUI against the real controller over HTTPS", () => {
  let directory = "";
  let emitted = "";
  let fixture: ControllerFixture;
  let caddy: RunningProcess | null = null;
  let browser: Browser | null = null;
  let publicOrigin = "";
  let projectId = "";
  let ownerId = "";
  let readerId = "";
  let operatorId = "";
  let knowledgeProjectId = "";

  beforeAll(async () => {
    const version = await execFileAsync(caddyBinary, ["version"]);
    expect(version.stdout.trim()).toMatch(/^v2\.11\.3(?:\s|$)/);
    directory = await mkdtemp(join(tmpdir(), "worktree-control-account-https-"));
    emitted = await mkdtemp(join(tmpdir(), "account-provider-emitted-"));
    // The proof provider builds exactly as in the provider administration integration test.
    await symlink(join(repositoryRoot, "packages/auth-provider-better-auth-proof/node_modules"), join(emitted, "node_modules"), "dir");
    await execFileAsync(process.execPath, ["node_modules/tsup/dist/cli-default.js", "packages/auth-provider-better-auth-proof/src/index.ts",
      "--format", "esm", "--platform", "node", "--target", "node22", "--out-dir", emitted,
      "--external", "better-auth", "--external", "@better-auth/core", "--external", "kysely",
      "--external", "@better-auth/passkey", "--external", "@better-auth/utils"], { cwd: repositoryRoot, timeout: 30_000 });
    const providerModule = join(emitted, "index.js");
    // The protected entry check refuses group-writable modules regardless of the runner's umask.
    await chmod(providerModule, 0o600);

    const publicPort = await freePort();
    publicOrigin = `https://switcher.localhost:${publicPort}`;
    // Account mode requires --public-url, which the restart below adds; token mode
    // would reject local fixture requests once a public origin is configured.
    fixture = await startControllerFixture(1);
    projectId = fixture.projects[0]!.id;
    const cli = (args: string[], input?: unknown) => fixture.cliResult(args, input).then(result => {
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {};
    });

    await cli(["auth", "provider", "configure", "--input-stdin"], { module: providerModule, origin: publicOrigin, signingSecret: { kind: "generate" } });
    ownerId = ((await cli(["auth", "provider", "owner", "create"])).principal as { id: string }).id;
    readerId = ((await cli(["auth", "provider", "human", "create"])).principal as { id: string }).id;
    operatorId = ((await cli(["auth", "provider", "human", "create"])).principal as { id: string }).id;
    const enrollment = join(directory, "enrollment.json");
    for (const [id, email, password] of [[ownerId, ownerEmail, ownerPassword], [readerId, readerEmail, readerPassword], [operatorId, operatorEmail, operatorPassword]] as const) {
      await writeFile(enrollment, JSON.stringify({ email, name: email.split("@")[0], password }), { mode: 0o600 });
      expect(await cli(["auth", "provider", "enroll", "--principal-id", id, "--input-file", enrollment])).toMatchObject({ enrolled: true });
    }
    // No default project access exists, including for an owner; each grant is explicit.
    const operatorAll = { scope: { kind: "runtime-project", id: projectId }, role: "operator",
      permissions: ["projects:read", "claims:manage", "runtime:control", "tests:run", "profiles:select", "config:write"], expectedRevision: 0 };
    await cli(["auth", "provider", "runtime-access", "set", "--input-stdin"], { principalId: ownerId, ...operatorAll });
    await cli(["auth", "provider", "runtime-access", "set", "--input-stdin"], { principalId: operatorId, ...operatorAll, permissions: ["projects:read", "claims:manage", "runtime:control", "tests:run"] });
    await cli(["auth", "provider", "runtime-access", "set", "--input-stdin"], { principalId: readerId, scope: operatorAll.scope, role: "reader", permissions: ["projects:read"], expectedRevision: 0 });
    knowledgeProjectId = ((await cli(["identity", "create-knowledge-project", "--name", "Account knowledge"])).project as { id: string }).id;
    // Knowledge memberships are human-only by contract; the owner can never hold one.
    await cli(["auth", "provider", "knowledge-access", "set", "--input-stdin"], {
      principalId: operatorId, scope: { kind: "knowledge-project", id: knowledgeProjectId }, role: "operator",
      permissions: ["knowledge:read", "knowledge:write"], expectedRevision: 0,
    });
    await cli(["auth", "mode", "set", "better-auth"]);
    await fixture.restart(["--public-url", publicOrigin]);

    const ca = await createCertificateAuthority(directory);
    const server = await createServerCertificate(directory, ca);
    const backendPort = Number(new URL(fixture.endpoint).port);
    const config = join(directory, "Caddyfile");
    await writeFile(config, caddyfile({ publicPort, backendPort, certificate: server.certificate, key: server.key }));
    const caddyData = join(directory, "caddy-data");
    await mkdir(caddyData);
    caddy = startProcess(caddyBinary, ["run", "--config", config, "--adapter", "caddyfile"], {
      PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production", XDG_DATA_HOME: caddyData, XDG_CONFIG_HOME: join(directory, "caddy-config"),
    });
    await waitFor(async () => {
      if (await portOpen(publicPort)) return true;
      if (caddy?.child.exitCode !== null) throw new Error(`Caddy exited early.\n${caddy?.output()}`);
      return null;
    }, 15_000, () => "Caddy did not become ready.");

    const certificate = new X509Certificate(await readFile(server.certificate));
    const spkiHash = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64");
    browser = await chromium.launch({
      args: [`--ignore-certificate-errors-spki-list=${spkiHash}`, "--host-resolver-rules=MAP switcher.localhost 127.0.0.1"],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await stopProcess(caddy);
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (emitted) await rm(emitted, { recursive: true, force: true });
  });

  it("runs the password session lifecycle with real cookies and no stored secret", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(publicOrigin);
      await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();

      await signIn(page, ownerEmail, "wrong-password");
      await pwExpect(page.getByText("Sign-in failed. Check the credentials and try again.")).toBeVisible();

      await signIn(page, ownerEmail, ownerPassword);
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible();
      // The HttpOnly cookie is the sole authority: nothing is stored or put in the URL.
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      expect(page.url()).not.toMatch(/token|password/i);

      // Claim, control and test rights come from the backend actions, not the owner label.
      await page.getByLabel("Claim reason").fill("GUI HTTPS proof");
      await page.getByRole("button", { name: "Claim", exact: true }).click();
      await pwExpect(page.getByRole("button", { name: "Renew" })).toBeVisible();
      await pwExpect(page.getByRole("button", { name: "Release" })).toBeVisible();

      await pwExpect(page.getByRole("heading", { name: "Tests" })).toBeVisible();
      await page.getByRole("button", { name: "Run", exact: true }).first().click();
      await pwExpect(page.getByText("Passed").first()).toBeVisible({ timeout: 45_000 });

      await page.getByRole("tab", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Release" }).click();
      await pwExpect(page.getByRole("button", { name: "Claim", exact: true })).toBeVisible();

      await signOut(page);
      await page.reload();
      await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    } finally {
      await page.close();
    }
  }, 120_000);

  it("shows a reader only reads and never lets the GUI infer rights", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(publicOrigin);
      await signIn(page, readerEmail, readerPassword);
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible();
      await pwExpect(page.getByText("This account has read-only access to the project.")).toBeVisible();
      await pwExpect(page.getByRole("button", { name: "Claim", exact: true })).toHaveCount(0);
      await pwExpect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
      await pwExpect(page.getByRole("heading", { name: "Tests" })).toHaveCount(0);
      await pwExpect(page.getByRole("heading", { name: "Configuration" })).toHaveCount(0);
      await signOut(page);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("enrolls TOTP and a passkey, survives recovery and denies the revoked session", async () => {
    const page = await browser!.newPage();
    try {
      await page.goto(publicOrigin);
      // Real TOTP self-service enrollment, then the session ends by contract.
      await signIn(page, operatorEmail, operatorPassword);
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible();
      await page.getByRole("tab", { name: "Security" }).click();
      await page.getByLabel("Confirm with password").fill(operatorPassword);
      await page.getByRole("button", { name: "Enable TOTP" }).click();
      const uri = await page.getByLabel("Authenticator app URI").inputValue();
      const secret = new URL(uri).searchParams.get("secret");
      expect(secret).toBeTruthy();
      await fillFreshTotp(page, secret!);
      await page.getByRole("button", { name: "Verify" }).click();
      await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
      await pwExpect(page.getByText("TOTP was enabled. Sign in again.")).toBeVisible();

      // Password sign-in now returns the real TOTP challenge.
      await signIn(page, operatorEmail, operatorPassword);
      await pwExpect(page.getByRole("heading", { name: "Verification code" })).toBeVisible();
      await fillFreshTotp(page, secret!);
      await page.getByRole("button", { name: "Verify" }).click();
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible();
      // The operator subset has no configuration rights; the panel stays absent.
      await pwExpect(page.getByRole("heading", { name: "Configuration" })).toHaveCount(0);
      // The operator's human knowledge membership flows through the same session cookie.
      await page.getByRole("tab", { name: "Knowledge" }).click();
      await pwExpect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(knowledgeProjectId);
      await page.getByRole("tab", { name: "Projects" }).click();

      // Real WebAuthn enrollment through a virtual authenticator.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
      }) as { authenticatorId: string };
      await page.getByRole("tab", { name: "Security" }).click();
      await page.getByRole("button", { name: "Register a passkey" }).click();
      await pwExpect(page.getByText("Passkey created. Confirm it to finish registration.")).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Confirm passkey" }).click();
      await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible({ timeout: 20_000 });
      await pwExpect(page.getByText("The passkey was registered. Sign in again.")).toBeVisible();

      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible({ timeout: 20_000 });
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });

      // Recovery replaces the password and revokes every subject session immediately.
      const recovered = await fixture.cliResult(["auth", "provider", "recover", "--principal-id", operatorId, "--input-stdin"], { newPassword: recoveredPassword });
      expect(recovered.code, recovered.stderr).toBe(0);
      // The provider's in-memory sign-in rate limit (5/60s per client) is spent by the
      // earlier lifecycle proofs; a restart also proves the recovered password is durable.
      await fixture.restart(["--public-url", publicOrigin]);
      await page.reload();
      await pwExpect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
      const [denied] = await Promise.all([
        page.waitForResponse(response => response.url().includes("/api/auth/sign-in"), { timeout: 20_000 }),
        signIn(page, operatorEmail, operatorPassword),
      ]);
      // The revoked password is denied as a credential, never as a rate-limit artifact.
      expect(denied.status()).toBe(401);
      await pwExpect(page.getByText("Sign-in failed. Check the credentials and try again.")).toBeVisible({ timeout: 15_000 });
      await signIn(page, operatorEmail, recoveredPassword);
      await pwExpect(page.getByRole("heading", { name: "Verification code" })).toBeVisible();
      await fillFreshTotp(page, secret!);
      await page.getByRole("button", { name: "Verify" }).click();
      await pwExpect(page.getByRole("heading", { name: "project-a" })).toBeVisible();
    } finally {
      await page.close();
    }
  }, 240_000);
});
