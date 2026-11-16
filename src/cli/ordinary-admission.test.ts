import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../server/paths";
import { createFencedAt49 } from "../server/infrastructure/sqlite/fixtures/released-schema";
import { bootstrapServiceInstallationToken } from "./first-run-token";

/**
 * The ordinary admission through the registered CLI (`src/cli/index.ts`, run
 * with tsx as the installed executable runs its build): every family that opens
 * the store refuses a fenced schema-49 database with a non-empty WAL as
 * `upgrade_required`, printed as the upgrade error body on stderr with exit
 * code 1, before anything is written: the database, its WAL and the witness are
 * byte-identical, and no plan, backup, handoff, token or listener appears.
 * Service install's pre-bootstrap is called directly (the command itself needs
 * a built entry and a user service manager).
 */
const exec = promisify(execFile);
const repositoryRoot = resolve(".");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BODY = {
  code: "upgrade_required",
  error: "upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.",
  nextStep: "upgrade inspect",
  state: "upgrade_needed",
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A fenced schema-49 installation whose WAL holds committed frames the main file lacks. */
function installation() {
  const root = mkdtempSync(join(tmpdir(), "cli-admission-")); roots.push(root);
  const paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  createFencedAt49(paths.databasePath);
  const path = join(realpathSync(paths.dataDirectory), "state.sqlite3"), writer = new Database(path, { fileMustExist: true });
  let main: Buffer, wal: Buffer;
  try {
    writer.pragma("journal_mode = WAL"); writer.pragma("wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('fixture.frames','fixture',?,?)").run(JSON.stringify({ marker: randomUUID() }), new Date().toISOString());
    main = readFileSync(path); wal = readFileSync(`${path}-wal`);
  } finally { writer.close(); }
  writeFileSync(path, main); writeFileSync(`${path}-wal`, wal, { mode: 0o600 }); chmodSync(`${path}-wal`, 0o600);
  rmSync(`${path}-shm`, { force: true });
  mkdirSync(join(root, "home"));
  return { root, paths };
}
/** The database, its non-empty WAL, the witness, and every other entry beside them, in the state directory and in the root. */
function state(root: string, paths: AppPaths) {
  const data = realpathSync(paths.dataDirectory), path = join(data, "state.sqlite3");
  expect(lstatSync(`${path}-wal`).size).toBeGreaterThan(0);
  const sidecars = new Set(["state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm", "state.sqlite3.owner.lock"]);
  return {
    database: sha(readFileSync(path)), wal: sha(readFileSync(`${path}-wal`)),
    witness: readFileSync(join(`${path}.security`, "witness.json"), "utf8"),
    data: readdirSync(data).filter(name => !sidecars.has(name)).sort(),
    // The lock files may be created; the state directory holds nothing else afterwards.
    state: existsSync(paths.stateDirectory) ? readdirSync(paths.stateDirectory).filter(name => name !== "controller.lock").sort() : [],
    root: readdirSync(root).filter(name => name !== "state").sort(),
  };
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>(done => server.close(() => done()));
  return port;
}
const refused = (port: number) => new Promise<boolean>(done => {
  const socket = createConnection({ port, host: "127.0.0.1" });
  socket.once("connect", () => { socket.destroy(); done(false); });
  socket.once("error", () => done(true));
});
/** Runs the CLI entry with an environment that points every default directory into the root. */
async function cli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = join(root, "home");
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CONFIG_HOME: join(home, ".config"),
  };
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", join(repositoryRoot, "src/cli/index.ts"), ...args],
      { cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

describe("the ordinary admission through the registered CLI", () => {
  it("refuses every family that opens the store with upgrade_required, before anything is written", async () => {
    const port = await freePort();
    const families: Array<[string, (paths: AppPaths, root: string) => string[]]> = [
      ["start", (paths, root) => { const web = join(root, "web"); mkdirSync(web, { recursive: true });
        return ["start", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory, "--host", "127.0.0.1", "--port", String(port), "--no-mcp", "--no-open", "--web-root", web]; }],
      ["start with the deprecated --backup-before-migration", (paths, root) => { const web = join(root, "web"); mkdirSync(web, { recursive: true });
        return ["start", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory, "--host", "127.0.0.1", "--port", String(port), "--no-mcp", "--no-open", "--web-root", web,
          "--backup-before-migration", "--backup-dir", join(root, "start-backups")]; }],
      ["auth status", paths => ["auth", "status", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["auth provider status", paths => ["auth", "provider", "status", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["identity", paths => ["identity", "list-agents", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["knowledge execute-import", (paths, root) => { const plan = join(root, "plan.json"); writeFileSync(plan, "{}");
        return ["knowledge", "execute-import", "--plan-file", plan, "--target-id", "target", "--target-name", "Target", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]; }],
      ["project list", paths => ["project", "list", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["doctor", paths => ["doctor", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["config mcp", paths => ["config", "mcp", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
      ["remote-verification inspect", paths => ["remote-verification", "inspect", "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory]],
    ];
    const results = await Promise.all(families.map(async ([name, args]) => {
      const { root, paths } = installation(), argv = args(paths, root), before = state(root, paths);
      const result = await cli(root, argv);
      // The backup directory of the deprecated flag is the operator's: no copy is taken into it.
      return { name, result, before, after: state(root, paths), copies: existsSync(join(root, "start-backups")) ? readdirSync(join(root, "start-backups")) : [] };
    }));
    for (const { name, result, before, after, copies } of results) {
      expect(result.code, `${name}: ${result.stderr}`).toBe(1);
      expect(JSON.parse(lastLine(result.stderr)), name).toEqual(BODY);
      expect(after, name).toEqual(before);
      expect(copies, name).toEqual([]);
      // No listener, no access record, no admin socket, no first-run token was announced.
      expect(result.stdout, name).not.toMatch(/listening|wsi_/i);
    }
    // The deprecated flag prints its one notice and takes no copy.
    const deprecated = results.find(({ name }) => name.startsWith("start with"))!;
    expect(deprecated.result.stderr).toContain("--backup-before-migration is deprecated and takes no copy");
    expect(results.find(({ name }) => name === "start")!.result.stderr).not.toContain("deprecated");
    expect(await refused(port)).toBe(true);
  }, 90_000);

  it("refuses service install's pre-bootstrap before it issues a token", () => {
    const { root, paths } = installation(), before = state(root, paths), written: string[] = [];
    expect(() => bootstrapServiceInstallationToken(paths, { terminal: { write: (text: string) => { written.push(text); return true; } } as unknown as NodeJS.WriteStream, locale: "en" }))
      .toThrowError(expect.objectContaining({ name: "UpgradeError", code: "upgrade_required" }));
    expect(written).toEqual([]);
    expect(state(root, paths)).toEqual(before);
  }, 30_000);
});
