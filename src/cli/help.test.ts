import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import { CLI_HELP, cliInformation } from "./help";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CLI help and version", () => {
  it("answers help and version requests and nothing else", () => {
    for (const flag of ["--help", "-h", "help"]) expect(cliInformation([flag], "1.2.3")).toBe(CLI_HELP);
    for (const flag of ["--version", "-v"]) expect(cliInformation([flag], "1.2.3")).toBe("1.2.3");
    // Subcommand help keeps its own handling, e.g. the service option validation.
    for (const args of [[], ["start"], ["service", "--help"], ["auth", "-h"], ["--host", "127.0.0.1"], ["--no-open"]]) {
      expect(cliInformation(args, "1.2.3")).toBeNull();
    }
  });

  it("lists every real top-level command once", () => {
    const commands = CLI_HELP.split("\n").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().split(/\s{2,}/)[0]);
    expect(commands).toEqual([
      "start", "service", "auth", "backup", "project", "doctor", "knowledge", "identity",
      "config mcp", "config path", "mcp diagnostics", "help, --help, -h", "--version, -v",
    ]);
  });

  it("exits successfully without creating data or state directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-control-help-"));
    directories.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const environment = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      WORKTREE_CONTROL_DATA_DIR: join(root, "control-data"),
      WORKTREE_CONTROL_STATE_DIR: join(root, "control-state"),
    };
    const run = (flag: string) => exec(process.execPath, ["--import", "tsx", join(repositoryRoot, "src/cli/index.ts"), flag], {
      // tsx resolves from the checkout; every application directory points into the temporary root.
      cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 30_000,
    });
    const results = await Promise.all(["--help", "-h", "help", "--version", "-v"].map(run));
    for (const { stdout, stderr } of results.slice(0, 3)) {
      expect(stdout).toBe(`${CLI_HELP}\n`);
      expect(stderr).toBe("");
    }
    for (const { stdout, stderr } of results.slice(3)) {
      expect(stdout).toBe(`${packageJson.version}\n`);
      expect(stderr).toBe("");
    }
    expect(readdirSync(root)).toEqual(["home"]);
    expect(readdirSync(home)).toEqual([]);
  }, 60_000);
});
