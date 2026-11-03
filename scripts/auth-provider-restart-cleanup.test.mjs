import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { cleanupRestartFixture, trackFixtureChild } from "./auth-provider-restart-cleanup.mjs";

test("cleanup waits for every close before removing the installation", async () => {
  const children = new Map();
  const first = new EventEmitter(), second = new EventEmitter();
  let signals = 0, removed = false;
  for (const child of [first, second]) {
    child.kill = signal => { assert.equal(signal, "SIGKILL"); signals++; return true; };
    trackFixtureChild(children, child);
  }
  const cleanup = cleanupRestartFixture(children, () => { removed = true; });
  assert.equal(signals, 2);
  first.emit("close", null, "SIGKILL");
  await Promise.resolve();
  assert.equal(removed, false);
  assert.equal(children.size, 1);
  second.emit("close", null, "SIGKILL");
  await cleanup;
  assert.equal(removed, true);
  assert.equal(children.size, 0);
});

test("unconfirmed closure retains the installation and can be retried after close", async () => {
  const children = new Map(), child = new EventEmitter();
  let removed = false;
  child.kill = () => true;
  trackFixtureChild(children, child);
  await assert.rejects(cleanupRestartFixture(children, () => { removed = true; }, 10), /closure unconfirmed/);
  assert.equal(removed, false);
  assert.equal(children.size, 1);
  child.emit("close", null, "SIGKILL");
  await cleanupRestartFixture(children, () => { removed = true; });
  assert.equal(removed, true);
});

test("a failed signal does not skip stopping other owned children", async () => {
  const children = new Map(), first = new EventEmitter(), second = new EventEmitter();
  let secondSignalled = false, removed = false;
  first.kill = () => { queueMicrotask(() => first.emit("close", 1, null)); throw new Error("signal refused"); };
  second.kill = () => { secondSignalled = true; second.emit("close", null, "SIGKILL"); return true; };
  trackFixtureChild(children, first);
  trackFixtureChild(children, second);
  await assert.rejects(cleanupRestartFixture(children, () => { removed = true; }), /signal request failed/);
  assert.equal(secondSignalled, true);
  assert.equal(removed, true);
  assert.equal(children.size, 0);
});

test("actual owned process has closed before installation removal", async () => {
  const children = new Map();
  const child = spawn(process.execPath, ["-e", 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = trackFixtureChild(children, child);
  child.on("error", () => undefined);
  try {
    await once(child, "message");
    await cleanupRestartFixture(children, () => { assert.equal(child.signalCode, "SIGKILL"); assert.equal(children.size, 0); });
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
  } finally {
    await cleanupRestartFixture(children, () => undefined);
  }
});
