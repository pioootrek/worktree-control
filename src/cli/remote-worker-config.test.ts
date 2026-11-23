import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRemoteWorkerToken, remoteVerificationConfigSchema } from "./remote-verification";
import { loadWorkerProcessConfig, readWorkerCredential, workerProcessConfigSchema } from "./remote-worker-config";
import { parseWorkerStartArgs, WORKER_USAGE } from "./worker-command";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "wtc-worker-config-")); roots.push(root); return root; }

const mapping = { projectId: "project", localProjectId: "local", sourceCachePath: "/fixture/cache", sourceRemote: "origin", presetIds: ["node:test"] };
const config = { version: 1, workerId: "worker", origin: "https://broker.invalid", credentialFile: "/fixture/credential", workspaceRoot: "/fixture/attempts", mappings: [mapping] };
const legacyToken = `wts_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}_${"a".repeat(64)}`;

describe("worker-only configuration", () => {
  it("accepts the versioned file and defaults the loopback fixture switch to off", () => {
    expect(workerProcessConfigSchema.parse(config)).toEqual({ ...config, allowLoopbackHttpFixture: false });
  });

  it("rejects a listener, unknown keys, other versions and relative paths", () => {
    const parse = (value: object) => workerProcessConfigSchema.safeParse(value).success;
    expect(parse({ ...config, listener: { host: "127.0.0.1", port: 18000, allowLoopbackHttpFixture: true } })).toBe(false);
    expect(parse({ ...config, tokenFile: "/fixture/token" })).toBe(false);
    expect(parse({ ...config, version: 2 })).toBe(false);
    for (const key of ["credentialFile", "workspaceRoot"] as const) expect(parse({ ...config, [key]: "relative/path" })).toBe(false);
    expect(parse({ ...config, mappings: [{ ...mapping, sourceCachePath: "cache" }] })).toBe(false);
    expect(parse({ ...config, mappings: [{ ...mapping, command: "pnpm test" }] })).toBe(false);
    expect(parse({ ...config, mappings: [] })).toBe(false);
  });

  it("shares the mapping schema with the embedded configuration", () => {
    const policy = { kind: "pnpm", nodeExecutable: "/tools/node", nodeVersion: "24.15.0", pnpmEntryPoint: "/tools/pnpm.cjs", pnpmVersion: "11.5.2", scripts: "trusted-repository" };
    const withSetup = { ...mapping, dependencySetup: policy, preparationTimeoutMs: 600_000 };
    expect(workerProcessConfigSchema.safeParse({ ...config, mappings: [withSetup] }).success).toBe(true);
    expect(remoteVerificationConfigSchema.safeParse({ version: 1, worker: { workerId: "worker", origin: "https://broker.invalid", tokenFile: "/fixture/token", workspaceRoot: "/fixture/attempts", mappings: [withSetup] } }).success).toBe(true);
    expect(workerProcessConfigSchema.safeParse({ ...config, mappings: [{ ...withSetup, preparationTimeoutMs: 0 }] }).success).toBe(false);
  });

  it("reports an unreadable or invalid file without echoing its content", () => {
    const root = directory(), file = join(root, "worker.json");
    writeFileSync(file, JSON.stringify({ ...config, credentialFile: "secret-looking-value" }));
    expect(() => loadWorkerProcessConfig(file)).toThrow(/^Invalid worker configuration\.$/);
    expect(() => loadWorkerProcessConfig(join(root, "missing.json"))).toThrow(/^Invalid worker configuration\.$/);
  });
});

describe("worker credential file", () => {
  const write = (content: string, mode = 0o600) => {
    const file = join(directory(), "credential");
    writeFileSync(file, content, { mode });
    chmodSync(file, mode);
    return file;
  };

  it("accepts an opaque token and a legacy worker token, trimming one trailing newline", () => {
    expect(readWorkerCredential(write("wsi_opaque-installation.token~value\n"))).toBe("wsi_opaque-installation.token~value");
    expect(readWorkerCredential(write(`${legacyToken}\n`))).toBe(legacyToken);
    expect(readWorkerCredential(write("x".repeat(2048)))).toBe("x".repeat(2048));
  });

  it("rejects symlinks, shared permissions, oversized files and malformed values", () => {
    const target = write("opaque-credential-value");
    const link = join(directory(), "link");
    symlinkSync(target, link);
    expect(() => readWorkerCredential(link)).toThrow("Worker credential must be in an owner-only regular file.");
    expect(() => readWorkerCredential(write("opaque-credential-value", 0o640))).toThrow("owner-only");
    expect(() => readWorkerCredential(write("opaque-credential-value", 0o604))).toThrow("owner-only");
    expect(() => readWorkerCredential(write("x".repeat(4097)))).toThrow("Invalid worker credential file.");
    expect(() => readWorkerCredential(write("x".repeat(2049)))).toThrow("Invalid worker credential file.");
    for (const value of ["opaque credential value", "opaque-credential\tvalue", "line-one-credential\nline-two", "short-value", "", "zażółć-credential-value"]) {
      expect(() => readWorkerCredential(write(value)), JSON.stringify(value)).toThrow("Invalid worker credential file.");
    }
  });

  it("keeps the shared reader's messages for the embedded legacy token and a missing path", () => {
    const token = legacyToken;
    const target = write(`${token}\n`);
    expect(readRemoteWorkerToken(target)).toBe(token);
    const link = join(directory(), "link");
    symlinkSync(target, link);
    expect(() => readRemoteWorkerToken(link)).toThrow("Worker token must be in an owner-only regular file.");
    expect(() => readRemoteWorkerToken(write(token, 0o640))).toThrow("Worker token must be in an owner-only regular file.");
    expect(() => readWorkerCredential(join(directory(), "missing"))).toThrow(/^ENOENT: no such file or directory, lstat /);
  });

  // Mode 000 keeps the file owner-only and regular while the open fails for a non-root owner.
  // Root opens it anyway, and the descriptor path reports the same size error.
  it.skipIf(process.platform === "win32")("keeps the legacy size message for an owner-only file that cannot be opened", () => {
    const oversized = write(legacyToken.repeat(20), 0o000);
    expect(() => readRemoteWorkerToken(oversized)).toThrow(/^Invalid worker token file\.$/);
    expect(() => readWorkerCredential(write("x".repeat(4097), 0o000))).toThrow(/^Invalid worker credential file\.$/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports the open error for an unopenable file within the limit, as the legacy reader did", () => {
    expect(() => readRemoteWorkerToken(write(legacyToken, 0o000))).toThrow(/^EACCES: permission denied, open /);
  });

  it("refuses to read a credential where an atomic no-follow open is unavailable", async () => {
    const file = write("opaque-credential-value");
    vi.resetModules();
    const opened = vi.fn(), inspected = vi.fn();
    vi.doMock("node:fs", async importOriginal => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
        openSync: (...args: Parameters<typeof actual.openSync>) => { opened(args[0]); return actual.openSync(...args); },
        lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => { inspected(args[0]); return actual.lstatSync(...args); }) as unknown as typeof actual.lstatSync,
      };
    });
    try {
      const reader = await import("./remote-worker-config");
      const refusal = (() => { try { reader.readWorkerCredential(file); } catch (error) { return error as Error; } return null; })();
      expect(refusal?.message).toBe("Worker credential cannot be read safely on this platform: opening a file without following a symlink is unsupported.");
      expect(refusal?.message).not.toContain("opaque-credential-value");
      // No fallback: the path is neither inspected nor opened.
      expect(opened).not.toHaveBeenCalledWith(file);
      expect(inspected).not.toHaveBeenCalledWith(file);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const fifo = join(directory(), "credential");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    // A blocking open would wait for this writer, so a regression shows as a delay instead of a hang.
    const writer = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').openSync(process.argv[1], 'w'), 5000)", fifo], { stdio: "ignore" });
    try {
      const started = Date.now();
      expect(() => readWorkerCredential(fifo)).toThrow("Worker credential must be in an owner-only regular file.");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        const exited = once(writer, "exit");
        writer.kill("SIGKILL");
        await exited;
      }
    }
  }, 15_000);
});

describe("worker start arguments", () => {
  it("accepts the config, path and migration-backup options only", () => {
    expect(parseWorkerStartArgs(["start", "--config", "/c.json", "--data-dir", "/d", "--state-dir", "/s", "--backup-before-migration", "--backup-dir", "/b"])).toEqual({
      configPath: "/c.json", dataDirectory: "/d", stateDirectory: "/s", backupArgs: ["--backup-before-migration", "--backup-dir", "/b"],
    });
    for (const args of [[], ["stop"], ["start"], ["start", "--config"], ["start", "--config", "--data-dir"], ["start", "--config", "/a", "--config", "/b"],
      ["start", "--config", "/c", "--port", "47831"], ["start", "--config", "/c", "--remote-verification-config", "/r"], ["start", "--config", "/c", "--backup-interval-seconds", "60"]]) {
      expect(() => parseWorkerStartArgs(args), JSON.stringify(args)).toThrow(WORKER_USAGE);
    }
  });
});
