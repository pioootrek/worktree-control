import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSystemdUnit } from "../../src/cli/service-manager";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const cli = join(repository, "dist/cli/index.js");

describe.skipIf(process.platform !== "linux")("packaged service command safety", () => {
  let root: string, legacy: string, marker: string, environment: NodeJS.ProcessEnv, original: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "service-safety-"));
    const config = join(root, "config"), bin = join(root, "bin");
    legacy = join(config, "systemd/user/worktree-switcher.service");
    marker = join(root, "service-manager-called");
    await mkdir(join(config, "systemd/user"), { recursive: true });
    await mkdir(bin);
    // Never invoke the host's systemctl, including when testing a broken CLI.
    await writeFile(join(bin, "systemctl"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(90);\n`, { mode: 0o700 });
    environment = {
      ...process.env, HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"), PATH: bin,
      WORKTREE_CONTROL_DATA_DIR: join(root, "environment-data"), WORKTREE_CONTROL_STATE_DIR: join(root, "environment-state"),
    };
    original = renderSystemdUnit({
      nodePath: process.execPath, entrypointPath: "/old/dist/cli/index.js", workingDirectory: "/old", refresh: false,
      stateDirectory: join(root, "installed-state"),
      startArguments: [
        "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "49151", "--mcp-port", "49153",
        "--data-dir", join(root, "installed-data"), "--state-dir", join(root, "installed-state"),
        "--browse-root", join(root, "repos"), "--web-root", "/old/out", "--public-url", "https://control.example.test",
        "--backup-dir", join(root, "backups"), "--backup-interval-seconds", "86400", "--backup-retain-count", "7",
        "--backup-retain-days", "14", "--backup-max-bytes", "6442450944", "--mcp-max-sessions", "48",
      ],
    });
    await writeFile(legacy, original);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const run = (args: string[]) => exec(process.execPath, [cli, "service", ...args], { env: environment, cwd: repository, timeout: 10000 });
  async function unchanged() {
    expect(await readFile(legacy, "utf8")).toBe(original);
    for (const path of [marker, legacy.replace("worktree-switcher", "worktree-control"), join(root, "installed-state/logs"), join(root, "environment-state/logs")]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it("refuses help, unknown options and missing values before any service effect", async () => {
    for (const action of ["install", "status", "start", "stop", "restart", "url", "open", "uninstall"]) {
      for (const flag of ["--help", "-h", "--typo"]) await expect(run([action, flag])).rejects.toThrow("Usage: service");
    }
    await expect(run(["install", "--host"])).rejects.toThrow("requires one value");
    await unchanged();
  });

  it("prints the migrated definition with inherited policy without writing or calling systemctl", async () => {
    const { stdout } = await run(["install", "--print"]);
    for (const pair of ['"--host" "127.0.0.1"', '"--port" "49151"', '"--backup-interval-seconds" "86400"',
      '"--backup-retain-count" "7"', '"--backup-retain-days" "14"', '"--backup-max-bytes" "6442450944"',
      '"--public-url" "https://control.example.test"', '"--mcp-max-sessions" "48"']) expect(stdout).toContain(pair);
    expect(stdout).toContain(`"--data-dir" "${join(root, "installed-data")}"`);
    expect(stdout).toContain(`"--state-dir" "${join(root, "installed-state")}"`);
    expect(stdout).toContain(`"--web-root" "${join(repository, "out")}"`);
    expect(stdout).not.toContain('"0.0.0.0"');
    await unchanged();
  });

  it("requires explicit acceptance of a changed legacy setting and allows its read-only preview", async () => {
    await expect(run(["install", "--port", "49152"])).rejects.toThrow("--yes");
    await unchanged();
    const { stdout } = await run(["install", "--port", "49152", "--print"]);
    expect(stdout).toContain('--port: ["49151"] -> ["49152"]');
    expect(stdout).toContain('"--port" "49152"');
    await unchanged();
  });

  it("refuses ambiguous current and legacy definitions without choosing one policy", async () => {
    const current = legacy.replace("worktree-switcher", "worktree-control");
    await writeFile(current, original.replace('"--port" "49151"', '"--port" "49154"'));
    await expect(run(["install", "--refresh", "--yes"])).rejects.toThrow("Both current and legacy");
    expect(await readFile(legacy, "utf8")).toBe(original);
    expect(await readFile(current, "utf8")).toContain('"--port" "49154"');
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews resetting an inherited setting to its actual default", async () => {
    const { stdout } = await run(["install", "--unset", "--backup-retain-count", "--print"]);
    expect(stdout).toContain('--backup-retain-count: ["7"] -> ["30"]');
    expect(stdout).toContain('"--backup-retain-count" "30"');
    await unchanged();
  });
});
