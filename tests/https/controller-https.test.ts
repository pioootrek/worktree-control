import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createConnection, createServer } from "node:net";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const caddyBinary = process.env.CADDY_BIN!;
const syntheticMarker = "https-fixture-marker-not-a-credential";

interface RunningProcess {
  child: ChildProcess;
  output(): string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a fixture port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolveProbe(open); };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitFor<T>(read: () => Promise<T | null>, message: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

function startProcess(executable: string, args: string[], environment: NodeJS.ProcessEnv): RunningProcess {
  let output = "";
  const child = spawn(executable, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function stopProcess(process: RunningProcess | null): Promise<void> {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  await waitFor(async () => process.child.exitCode !== null || process.child.signalCode !== null ? true : null, "Fixture process did not stop.");
}

async function createCertificateAuthority(directory: string): Promise<{ certificate: string; key: string }> {
  const certificate = join(directory, "fixture-ca.crt");
  const key = join(directory, "fixture-ca.key");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", certificate, "-days", "2", "-sha256", "-subj", "/CN=Worktree Switcher HTTPS Fixture CA",
  ]);
  return { certificate, key };
}

async function createServerCertificate(
  directory: string,
  ca: { certificate: string; key: string },
  name: string,
  serial: number,
  days: number,
): Promise<{ certificate: string; key: string }> {
  const certificate = join(directory, `${name}.crt`);
  const key = join(directory, `${name}.key`);
  const request = join(directory, `${name}.csr`);
  const extensions = join(directory, `${name}.ext`);
  await writeFile(extensions, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:switcher.localhost\n");
  await execFileAsync("openssl", [
    "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", request, "-sha256", "-subj", "/CN=switcher.localhost",
  ]);
  await execFileAsync("openssl", [
    "x509", "-req", "-in", request, "-CA", ca.certificate, "-CAkey", ca.key,
    "-set_serial", String(serial), "-out", certificate, "-days", String(days), "-sha256", "-extfile", extensions,
  ]);
  return { certificate, key };
}

function caddyfile(options: {
  publicPort: number;
  backendPort: number;
  certificate: string;
  key: string;
  accessLog: string;
}): string {
  return `{
  admin off
  auto_https disable_redirects
  log default {
    format filter {
      request>headers>X-Worktree-Switcher-Token delete
    }
  }
}

https://switcher.localhost:${options.publicPort} {
  tls ${options.certificate} ${options.key}
  log {
    output file ${options.accessLog}
    format filter {
      request>headers>X-Worktree-Switcher-Token delete
    }
  }
  reverse_proxy 127.0.0.1:${options.backendPort}
}
`;
}

async function secureRequest(options: {
  port: number;
  ca?: Buffer;
  servername?: string;
  path?: string;
  method?: string;
  token?: string;
  origin?: string;
  body?: string;
}): Promise<{ status: number; body: string; fingerprint: string }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port: options.port,
      servername: options.servername ?? "switcher.localhost",
      path: options.path ?? "/",
      method: options.method ?? "GET",
      ca: options.ca,
      headers: {
        Host: `switcher.localhost:${options.port}`,
        ...(options.token ? { "X-Worktree-Switcher-Token": options.token } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(options.body) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      const peer = (response.socket as TLSSocket).getPeerCertificate();
      const fingerprint = peer.raw ? createHash("sha256").update(peer.raw).digest("hex") : "";
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolveRequest({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          fingerprint,
        });
      });
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

async function firstEvent(options: { port: number; ca: Buffer; token: string; origin: string }): Promise<string> {
  return new Promise((resolveEvent, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port: options.port,
      servername: "switcher.localhost",
      path: "/api/events",
      ca: options.ca,
      headers: {
        Accept: "text/event-stream",
        Host: `switcher.localhost:${options.port}`,
        Origin: options.origin,
        "X-Worktree-Switcher-Token": options.token,
      },
    }, (response) => {
      let frame = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        frame += chunk;
        if (!frame.includes("\n\n")) return;
        request.destroy();
        resolveEvent(frame);
      });
    });
    request.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    request.end();
  });
}

describe("controller HTTPS through Caddy", () => {
  let directory = "";
  let controller: RunningProcess | null = null;
  let caddy: RunningProcess | null = null;

  beforeAll(async () => {
    const version = await execFileAsync(caddyBinary, ["version"]);
    expect(version.stdout.trim()).toMatch(/^v2\.11\.3(?:\s|$)/);
    directory = await mkdtemp(join(tmpdir(), "worktree-switcher-https-"));
  });

  afterAll(async () => {
    await stopProcess(caddy);
    await stopProcess(controller);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps the access page, API, SSE and local CLI available without plaintext downgrade or secret logging", async () => {
    const backendPort = await freePort();
    const publicPort = await freePort();
    const unusedPort = await freePort();
    const data = join(directory, "data");
    const state = join(directory, "state");
    const caddyData = join(directory, "caddy-data");
    const caddyConfig = join(directory, "Caddyfile");
    const accessLog = join(directory, "caddy-access.log");
    await Promise.all([mkdir(data), mkdir(state), mkdir(caddyData)]);
    const ca = await createCertificateAuthority(directory);
    const firstCertificate = await createServerCertificate(directory, ca, "server-first", 101, 2);
    const replacementCertificate = await createServerCertificate(directory, ca, "server-replacement", 102, 2);
    const expiredCertificate = await createServerCertificate(directory, ca, "server-expired", 103, 0);
    const publicOrigin = `https://switcher.localhost:${publicPort}`;
    const controlledEnvironment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" };
    const controllerArguments = [
      join(repositoryRoot, "dist/cli/index.js"), "start", "--service-mode", "--no-open", "--no-mcp",
      "--host", "127.0.0.1", "--port", String(backendPort),
      "--data-dir", data, "--state-dir", state, "--browse-root", directory, "--web-root", join(repositoryRoot, "out"),
    ];
    const generated = await execFileAsync(process.execPath, [
      join(repositoryRoot, "dist/cli/index.js"), "auth", "token", "generate", "--data-dir", data, "--state-dir", state,
    ], { env: controlledEnvironment });
    const token = (JSON.parse(generated.stdout) as { token: string }).token;
    controller = startProcess(process.execPath, controllerArguments, controlledEnvironment);
    const directAccess = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(state, "service-access.json"), "utf8")) as { accessUrl: string };
      } catch {
        return null;
      }
    }, "Direct controller did not publish its access record.");
    expect(new URL(directAccess.accessUrl).origin).toBe(`http://127.0.0.1:${backendPort}`);
    await stopProcess(controller);
    controller = startProcess(process.execPath, [...controllerArguments, "--public-url", publicOrigin], controlledEnvironment);
    const access = await waitFor(async () => {
      try {
        const current = JSON.parse(await readFile(join(state, "service-access.json"), "utf8")) as {
          pid: number; accessUrl: string; localDashboardEndpoint: string; publicDashboardEndpoint: string;
        };
        return current.publicDashboardEndpoint === publicOrigin ? current : null;
      } catch {
        if (controller?.child.exitCode !== null) throw new Error(`Controller exited early.\n${controller?.output()}`);
        return null;
      }
    }, "Controller did not publish its access record.");
    expect(access.localDashboardEndpoint).toBe(`http://127.0.0.1:${backendPort}`);
    expect(access.publicDashboardEndpoint).toBe(publicOrigin);
    expect((await stat(join(state, "service-access.json"))).mode & 0o777).toBe(0o600);
    // Token mode never publishes a secret in the access record.
    expect(new URL(access.accessUrl).hash).toBe("");

    await expect(secureRequest({ port: publicPort })).rejects.toThrow();
    expect(await fetch(`http://127.0.0.1:${backendPort}/`).then((response) => response.status)).toBe(200);

    const startCaddy = async (backend: number, certificate = firstCertificate) => {
      await writeFile(caddyConfig, caddyfile({ publicPort, backendPort: backend, certificate: certificate.certificate, key: certificate.key, accessLog }));
      await execFileAsync(caddyBinary, ["validate", "--config", caddyConfig, "--adapter", "caddyfile"], {
        env: { ...controlledEnvironment, XDG_DATA_HOME: caddyData, XDG_CONFIG_HOME: join(directory, "caddy-config") },
      });
      caddy = startProcess(caddyBinary, ["run", "--config", caddyConfig, "--adapter", "caddyfile"], {
        ...controlledEnvironment,
        XDG_DATA_HOME: caddyData,
        XDG_CONFIG_HOME: join(directory, "caddy-config"),
      });
      await waitFor(async () => {
        try {
          await secureRequest({ port: publicPort, ca: await readFile(ca.certificate) });
          return true;
        } catch {
          if (caddy?.child.exitCode !== null) throw new Error(`Caddy exited early.\n${caddy?.output()}`);
          return null;
        }
      }, "Caddy did not become ready.");
    };

    await startCaddy(backendPort);
    const caContents = await readFile(ca.certificate);
    const landing = await secureRequest({ port: publicPort, ca: caContents, path: `/?marker=${syntheticMarker}` });
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("Worktree Switcher");

    const dashboard = await secureRequest({ port: publicPort, ca: caContents, path: "/api/dashboard", token, origin: publicOrigin });
    expect(dashboard.status).toBe(200);
    expect(JSON.parse(dashboard.body).projects).toEqual([]);
    const foreignRead = await secureRequest({
      port: publicPort,
      ca: caContents,
      path: "/api/dashboard",
      token,
      origin: "https://attacker.invalid",
    });
    expect(foreignRead.status).toBe(403);
    const mutation = await secureRequest({
      port: publicPort,
      ca: caContents,
      path: "/api/settings/capacity",
      method: "POST",
      token,
      origin: publicOrigin,
      body: JSON.stringify({ enabled: true, limit: 2 }),
    });
    expect(mutation.status).toBe(200);
    expect(await firstEvent({ port: publicPort, ca: caContents, token, origin: publicOrigin })).toContain("event: ready");
    expect(await firstEvent({ port: publicPort, ca: caContents, token, origin: publicOrigin })).toContain("event: ready");

    const cli = await execFileAsync(process.execPath, [
      join(repositoryRoot, "dist/cli/index.js"), "project", "list", "--json", "--data-dir", data, "--state-dir", state,
    ], { env: { ...controlledEnvironment, WORKTREE_SWITCHER_TOKEN: token } });
    expect(JSON.parse(cli.stdout)).toEqual([]);

    await expect(secureRequest({ port: publicPort, ca: caContents, servername: "wrong.localhost" })).rejects.toThrow();
    await expect(secureRequest({ port: publicPort })).rejects.toThrow();
    const plaintext = await fetch(`http://127.0.0.1:${publicPort}/`);
    expect(plaintext.status).toBe(400);
    expect(await plaintext.text()).not.toContain("Worktree Switcher");

    const firstFingerprint = dashboard.fingerprint;
    await stopProcess(caddy);
    caddy = null;
    await expect(secureRequest({ port: publicPort, ca: caContents })).rejects.toThrow();
    expect(controller.child.exitCode).toBeNull();
    await startCaddy(backendPort, replacementCertificate);
    const replacement = await secureRequest({ port: publicPort, ca: caContents, path: "/api/dashboard", token, origin: publicOrigin });
    expect(replacement.status).toBe(200);
    expect(replacement.fingerprint).not.toBe(firstFingerprint);
    expect(access.pid).toBe(controller.child.pid);

    await stopProcess(caddy);
    caddy = null;
    await startCaddy(unusedPort, replacementCertificate);
    const unavailableBackend = await secureRequest({ port: publicPort, ca: caContents, path: "/api/dashboard", token, origin: publicOrigin });
    expect(unavailableBackend.status).toBe(502);
    await stopProcess(caddy);
    caddy = null;

    await writeFile(caddyConfig, caddyfile({
      publicPort,
      backendPort,
      certificate: expiredCertificate.certificate,
      key: expiredCertificate.key,
      accessLog,
    }));
    await execFileAsync(caddyBinary, ["validate", "--config", caddyConfig, "--adapter", "caddyfile"], {
      env: { ...controlledEnvironment, XDG_DATA_HOME: caddyData, XDG_CONFIG_HOME: join(directory, "caddy-config") },
    });
    caddy = startProcess(caddyBinary, ["run", "--config", caddyConfig, "--adapter", "caddyfile"], {
      ...controlledEnvironment,
      XDG_DATA_HOME: caddyData,
      XDG_CONFIG_HOME: join(directory, "caddy-config"),
    });
    await waitFor(async () => {
      if (await portOpen(publicPort)) return true;
      if (caddy?.child.exitCode !== null) throw new Error(`Caddy rejected the expired fixture unexpectedly.\n${caddy?.output()}`);
      return null;
    }, "Expired-certificate fixture did not start.");
    await expect(secureRequest({ port: publicPort, ca: caContents })).rejects.toThrow();
    const expiredPlaintext = await fetch(`http://127.0.0.1:${publicPort}/`);
    expect(expiredPlaintext.status).toBe(400);
    expect(await expiredPlaintext.text()).not.toContain("Worktree Switcher");
    await stopProcess(caddy);
    caddy = null;
    await startCaddy(backendPort, replacementCertificate);

    const certificate = new X509Certificate(await readFile(replacementCertificate.certificate));
    const spki = certificate.publicKey.export({ type: "spki", format: "der" });
    const spkiHash = createHash("sha256").update(spki).digest("base64");
    const browser = await chromium.launch({
      args: [
        `--ignore-certificate-errors-spki-list=${spkiHash}`,
        "--host-resolver-rules=MAP switcher.localhost 127.0.0.1",
      ],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${publicOrigin}/#token=${encodeURIComponent(token)}`);
      await page.getByRole("heading", { name: /Add your first project|Dodaj pierwszy projekt/ }).waitFor({ state: "visible" });
      const browserUrl = new URL(page.url());
      expect(browserUrl.origin).toBe(publicOrigin);
      expect(browserUrl.hash).toBe("");
    } finally {
      await browser.close();
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const diagnostics = `${controller.output()}\n${caddy!.output()}\n${await readFile(accessLog, "utf8")}`;
    expect(diagnostics).toContain(syntheticMarker);
    expect(diagnostics).not.toContain(token);
  });
});
