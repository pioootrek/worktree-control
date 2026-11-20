import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { buildOfflineOperationsRuntime } from "@/server/bootstrap/offline-operations-runtime";
import { closeOfflineStore } from "@/server/bootstrap/offline-store-ownership";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/sqlite-store";
import { resolveAppPaths } from "@/server/paths";
import type { AuthenticationMode } from "@/shared/contracts/operations";
import { sessionDescribe } from "./session-describe";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(mode: AuthenticationMode = "open") {
  const root = mkdtempSync(join(tmpdir(), "offline-ownership-")), paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  const lock = acquireControllerLock(paths.controllerLockPath);
  const store = new SqliteStateStore(paths.databasePath, undefined, { admission: "strict" });
  cleanups.push(async () => { await closeOfflineStore(store, lock); rmSync(root, { recursive: true, force: true }); });
  const build = (controllerLock = lock) => buildOfflineOperationsRuntime({ controllerLock, store, activeMode: mode, now: () => 1000,
    logs: { controller() {} }, projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git: { listTrees: async () => [], worktreeDirty: async () => false } }, requestBudget: new AuthenticationRequestBudget(16, 4),
    eligibility: { controllerEligible: () => true, providerSessionEligible: () => false } });
  const runtime = build();
  if (!runtime.supported) throw new Error("expected supported offline runtime");
  const replace = () => {
    renameSync(paths.controllerLockPath, join(root, "original.lock"));
    writeFileSync(paths.controllerLockPath, JSON.stringify({ pid: process.pid, token: "different-owner", startedAt: "now" }), { mode: 0o600 });
  };
  const releaseOptions = (commit = vi.fn()) => ({ eligible: runtime.eligible, connected: () => true, deadline: 2000, commit });
  return { root, paths, lock, store, runtime, build, replace, releaseOptions };
}
const error = { category: "unauthenticated", status: 401, reason: "offline_lock_not_held", retry: "reauthenticate", effect: null };
const refused = { ok: false, error };

/** Pause before the next real admitted callback; no SQL or admission ticket is held by the wait. */
function pauseAdmission(store: SqliteStateStore) {
  const admission = store.admission, entered = deferred(), resume = deferred();
  let pause = false;
  vi.spyOn(store, "admission", "get").mockReturnValue({ ...admission, async run(callback, options) {
    if (pause) { pause = false; entered.resolve(); await resume.promise; }
    return admission.run(callback, options);
  } });
  return { entered: entered.promise, resume: resume.resolve, arm() { pause = true; } };
}

describe("offline real lock and real SQLite ownership", () => {
  it.each(["open", "token", "better-auth"] as const)("describes and commits offline in %s while the real lock is held", async mode => {
    const f = fixture(mode), minted = await f.runtime.mintOffline({});
    if (!minted.ok) throw new Error("expected context");
    expect(await f.runtime.runner.run(sessionDescribe, minted.context, {})).toMatchObject({ ok: true,
      value: { actor: { kind: "operator" }, mode, listener: "offline", fullAuthority: true } });
    const commit = vi.fn(() => { f.store.getAuthenticationPolicy(); expect(f.lock.held()).toBe(true); });
    expect(await f.runtime.runner.readRelease(sessionDescribe, minted.context, {}, f.releaseOptions(commit))).toEqual({ status: "committed" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("refuses replacement before mint without requesting admission", async () => {
    const f = fixture(), admission = vi.spyOn(f.store, "admission", "get");
    f.replace(); expect(await f.runtime.mintOffline({})).toEqual(refused);
    expect(admission).not.toHaveBeenCalled();
  });

  it("rechecks the real lock inside mint after waiting for admission", async () => {
    const f = fixture(), gate = pauseAdmission(f.store);
    gate.arm(); const pending = f.build().mintOffline({});
    await gate.entered; f.replace(); gate.resume();
    expect(await pending).toEqual(refused);
  });

  it("refuses replacement between mint and execution, after admission wait", async () => {
    const f = fixture(), gate = pauseAdmission(f.store), runtime = f.build();
    const minted = await runtime.mintOffline({});
    if (!minted.ok || !runtime.supported) throw new Error("expected context");
    gate.arm(); const pending = runtime.runner.run(sessionDescribe, minted.context, {});
    await gate.entered; f.replace(); gate.resume();
    expect(await pending).toEqual(refused);
  });

  it("refuses replacement between execution and the final admitted release, with no DTO committed", async () => {
    const f = fixture(), gate = pauseAdmission(f.store), runtime = f.build();
    if (!runtime.supported) throw new Error("expected runner");
    const minted = await runtime.mintOffline({}); if (!minted.ok) throw new Error("expected context");
    expect(await runtime.runner.run(sessionDescribe, minted.context, {})).toMatchObject({ ok: true });
    gate.arm(); const commit = vi.fn();
    const pending = runtime.runner.readRelease(sessionDescribe, minted.context, {}, f.releaseOptions(commit));
    await gate.entered; f.replace(); gate.resume();
    expect(await pending).toEqual({ status: "refused", error }); expect(commit).not.toHaveBeenCalled();
  });

  it("negative control: omitting the release-stage held check exposes the exact forbidden success", async () => {
    const f = fixture(); let omit = false;
    const runtime = f.build({ ...f.lock, held: () => omit || f.lock.held() });
    if (!runtime.supported) throw new Error("expected runner");
    const minted = await runtime.mintOffline({}); if (!minted.ok) throw new Error("expected context");
    expect(await runtime.runner.run(sessionDescribe, minted.context, {})).toMatchObject({ ok: true });
    f.replace(); omit = true;
    const commit = vi.fn(), observed = await runtime.runner.readRelease(sessionDescribe, minted.context, {}, f.releaseOptions(commit));
    const expected = { status: "refused", error };
    expect(observed).toEqual({ status: "committed" }); expect(commit).toHaveBeenCalledTimes(1);
    expect(() => expect(observed).toEqual(expected)).toThrow(/committed/);
  });

  it("drains real accepted work and closes SQLite before lock release", async () => {
    const f = fixture(), started = deferred(), finish = deferred(), events: string[] = [];
    const work = f.store.admission.run(async () => { started.resolve(); await finish.promise; events.push("drained"); });
    await started.promise;
    const close = f.store.close.bind(f.store);
    vi.spyOn(f.store, "close").mockImplementation(() => { expect(f.lock.held()).toBe(true); close(); events.push("closed"); });
    const release = f.lock.release;
    vi.spyOn(f.lock, "release").mockImplementation(() => { expect(events).toEqual(["drained", "closed"]); events.push("released"); release(); });
    const closing = closeOfflineStore(f.store, f.lock);
    expect(events).toEqual([]); expect(f.lock.held()).toBe(true);
    finish.resolve(); await work; await closing;
    expect(events).toEqual(["drained", "closed", "released"]); expect(f.lock.held()).toBe(false);
  });

  it("a failing real store close leaves the controller lock held and unchanged", async () => {
    const f = fixture(), before = readFileSync(f.paths.controllerLockPath, "utf8"), failure = new Error("close unconfirmed");
    const close = vi.spyOn(f.store, "close").mockImplementation(() => { throw failure; }), release = vi.spyOn(f.lock, "release");
    await expect(closeOfflineStore(f.store, f.lock)).rejects.toBe(failure);
    expect(release).not.toHaveBeenCalled(); expect(f.lock.held()).toBe(true);
    expect(readFileSync(f.paths.controllerLockPath, "utf8")).toBe(before); close.mockRestore();
  });

  it("negative control: early lock release fails the exact close-order assertion", async () => {
    const f = fixture();
    f.lock.release();
    const observed = f.lock.held(), expected = true;
    expect(observed).toBe(false);
    expect(() => expect(observed, "controller lock held before SQLite close").toBe(expected)).toThrow(/expected false to be true/);
    await f.store.closeAfterDrain();
  });
});
