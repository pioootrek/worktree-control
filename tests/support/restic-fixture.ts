import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeFixtureChild, waitFor } from "./controller-fixture";
import { readProductEnvironment } from "../../src/server/product-environment";
const exec = promisify(execFile);
export const realResticAvailable = Boolean(readProductEnvironment(process.env, "WORKTREE_CONTROL_TEST_RESTIC") && readProductEnvironment(process.env, "WORKTREE_CONTROL_TEST_REST_SERVER"));
/** Operator-supplied verified official fixture binaries; never install or contact a production repository. */
export async function resticFixture() {
  const restic = readProductEnvironment(process.env, "WORKTREE_CONTROL_TEST_RESTIC")!, server = readProductEnvironment(process.env, "WORKTREE_CONTROL_TEST_REST_SERVER")!;
  const root = await mkdtemp(join(tmpdir(), "wts-restic-fixture-")), key = join(root, "password"), credentials = join(root, "credentials.json"), cert = join(root, "cert.pem"), tlsKey = join(root, "tls-key.pem"), repositoryRoot = join(root, "repository");
  let child: ChildProcess | undefined;
  try {
    await mkdir(repositoryRoot, { mode: 0o700 });
    await writeFile(key, "fixture-repository-password", { mode: 0o600 });
    await writeFile(credentials, JSON.stringify({ username: "fixture", password: "fixture-backend-password" }), { mode: 0o600 });
    // Bcrypt hash of the public fixture-only password above (no external htpasswd dependency).
    const htpasswd = join(root, "htpasswd"); await writeFile(htpasswd, 'fixture:$2b$05$e77bBvKJUyKcSAGwBNrerO6Omwd0Hu13fXGb.UqaZWM8HR3qcnI2q\n', { mode: 0o600 });
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKey, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { timeout: 15000, maxBuffer: 64 * 1024 });
    await chmod(cert, 0o600); await chmod(tlsKey, 0o600);
    const port = await new Promise<number>((accept, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const address = probe.address(); if (!address || typeof address === "string") return reject(new Error("Fixture port missing.")); probe.close(error => error ? reject(error) : accept(address.port)); }); });
    const repository = `rest:https://127.0.0.1:${port}/fixture/`;
    child = spawn(server, ["--listen", `127.0.0.1:${port}`, "--path", repositoryRoot, "--htpasswd-file", htpasswd, "--tls", "--tls-cert", cert, "--tls-key", tlsKey, "--append-only"], { stdio: "ignore" });
    const environment = { RESTIC_REPOSITORY: repository, RESTIC_PASSWORD_FILE: key, RESTIC_REST_USERNAME: "fixture", RESTIC_REST_PASSWORD: "fixture-backend-password", GOMAXPROCS: "2", NODE_ENV: "test" as const };
    const run = (args: string[], env: NodeJS.ProcessEnv = environment, cwd?: string) => exec(restic, ["--no-cache", "--cacert", cert, ...args], { env, cwd, timeout: 30000, maxBuffer: 1024 * 1024 });
    const runWithoutCa = (args: string[]) => exec(restic, ["--no-cache", ...args], { env: environment, timeout: 30000, maxBuffer: 1024 * 1024 });
    await waitFor(async () => { try { await run(["init", "--json"]); return true; } catch { if (child!.exitCode !== null) throw new Error("Fixture REST server exited before init."); return null; } }, 10000, () => "Disposable HTTPS REST repository did not initialize.");
    const repositoryId = (JSON.parse((await run(["cat", "config"])).stdout) as { id: string }).id;
    const startupArguments = ["--backup-remote-enabled", "--backup-remote-restic", restic, "--backup-remote-repository", repository, "--backup-remote-repository-id", repositoryId, "--backup-remote-password-file", key, "--backup-remote-credentials-file", credentials, "--backup-remote-ca-file", cert, "--backup-remote-attempt-limit", "1", "--backup-remote-timeout-seconds", "30"];
    const provenance = { restic: (await exec(restic, ["version"])).stdout.trim(), restServer: (await exec(server, ["--version"])).stdout.trim(), resticSha256: createHash("sha256").update(await readFile(restic)).digest("hex"), restServerSha256: createHash("sha256").update(await readFile(server)).digest("hex") };
    return { root, configuration: { executable: restic, repository, repositoryId, passwordFile: key, credentialsFile: credentials, caFile: cert }, startupArguments, run, runWithoutCa, environment, key, credentials, provenance, async close() { try { if (child) await closeFixtureChild(child); } finally { await rm(root, { recursive: true, force: true }); } } };
  } catch (error) { try { if (child) await closeFixtureChild(child); } finally { await rm(root, { recursive: true, force: true }); } throw error; }
}
