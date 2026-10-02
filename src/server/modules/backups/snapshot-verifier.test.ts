import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SnapshotVerifier } from "./snapshot-verifier";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "snapshot-verifier-")); roots.push(root);
  const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() }) as unknown as ChildProcess;
  vi.mocked(fork).mockReturnValue(child);
  return { root, child, verifier: new SnapshotVerifier(root, 1) };
}
it("bounds verification to one child and waits for its exit before cleaning the clone", async () => {
  const f = fixture(), pending = f.verifier.verify("/server/catalog/id");
  await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce());
  await expect(f.verifier.verify("/server/catalog/other")).rejects.toThrow("backup_busy");
  f.child.emit("message", { manifest: { formatVersion: 1, applicationVersion: "fixture", createdAt: "2026-10-01T00:00:00Z", database: { file: "state.sqlite3", size: 1, sha256: "a".repeat(64), schemaVersion: 1 }, attachments: [] } });
  let finished = false; void pending.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(readdirSync(f.root)).toHaveLength(1);
  f.child.emit("close", 0); await pending;
  expect(readdirSync(f.root)).toEqual([]); await f.verifier.close();
});
it.each(["timeout", "shutdown"])("kills only its own verifier and accounts for %s before cleanup", async mode => {
  const f = fixture(), pending = f.verifier.verify("/server/catalog/id");
  const rejected = expect(pending).rejects.toThrow("backup_failed");
  await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce());
  let closing: Promise<void> | undefined;
  if (mode === "timeout") await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 1500 });
  else closing = f.verifier.close();
  expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(readdirSync(f.root)).toHaveLength(1);
  f.child.emit("close", null); await rejected; await closing;
  expect(readdirSync(f.root)).toEqual([]);
  await f.verifier.close(); await expect(f.verifier.verify("/server/catalog/id")).rejects.toThrow("backup_busy");
});
