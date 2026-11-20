import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { acceptanceError, failureReport } from "./package-rbac-report.mjs";

test("failure attribution follows the first failed step in completion order", () => {
  const passed = { name: "closed-stdout", ok: true };
  const child = { name: "socket", ok: false };
  const parent = { name: "token-mode", ok: false };
  const report = steps => failureReport("fresh", steps, "fixture failure");
  assert.equal(report([passed, parent]).failureStep, parent.name);
  assert.equal(report([passed, child, parent]).failureStep, child.name);
  assert.equal(report([passed]).failureStep, undefined);
});

test("process diagnostics omit command arguments and output in step logs and final reports", async () => {
  const privateValue = "unregistered-fixture-detail";
  const script = "process.stderr.write(process.argv[1]); process.exitCode = 1";
  await assert.rejects(promisify(execFile)(process.execPath, ["-e", script, privateValue]), error => {
    assert.equal(error.stderr, privateValue);
    assert.equal(acceptanceError(error), "Subprocess failed");
    assert.equal(failureReport("fresh", [], error).error, "Subprocess failed");
    return true;
  });
});

test("only known npm codes can be copied from stderr", () => {
  const report = line => failureReport("fresh", [], Object.assign(new Error("fixture"), { stderr: line }));
  assert.equal(report("npm error code ENOSPC").npmErrorCode, "ENOSPC");
  assert.equal(report("npm error code PRIVATE_FIXTURE").npmErrorCode, undefined);
  assert.equal(report("npm error code ENOSPC_PRIVATE").npmErrorCode, undefined);
});

test("assertion diffs, messages and thrown values remain private", () => {
  const privateValue = "unregistered-provider-response";
  for (const error of [new TypeError(privateValue), new SyntaxError(privateValue), new Error(privateValue),
    new assert.AssertionError({ message: privateValue }), privateValue, null]) {
    assert(!acceptanceError(error).includes(privateValue));
  }
  assert.equal(acceptanceError(new Error("Finite fixture condition timed out.")), "Finite fixture condition timed out.");
});
