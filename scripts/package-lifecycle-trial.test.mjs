import assert from "node:assert/strict";
import test from "node:test";

import { inspectSystemdDefinition, parseArguments, redact } from "./package-lifecycle-trial.mjs";

test("lifecycle arguments require an explicit non-root UID", () => {
  assert.throws(() => parseArguments([]), /--expected-uid/);
  const common = [
    "--candidate", "candidate.tgz", "--candidate-sha256", "a".repeat(64), "--provenance", "provenance.json",
    "--prefix", "prefix with space", "--data-dir", "data", "--state-dir", "state", "--browse-root", "fixture",
    "--report", "report.json", "--expected-uid",
  ];
  assert.throws(() => parseArguments([...common, "0"]), /positive integer/);
  assert.equal(parseArguments([...common, "1234"]).expectedUid, 1234);
  assert.throws(() => parseArguments([...common, "1234", "--session-ready", "ready"]), /provided together/);
});

test("lifecycle reports redact browser and bearer credentials", () => {
  const value = redact("Bearer abc.DEF-123 http://127.0.0.1/#token=private-value package-lifecycle-secret-must-not-leak");
  assert.equal(value, "Bearer [REDACTED] http://127.0.0.1/#token=[REDACTED] [REDACTED]");
  assert.equal(redact(`token wsi_${"0".repeat(8)}-aaaa_${"f".repeat(64)}`), "token wsi_[REDACTED]");
});

test("systemd definition must point at installed paths and omit builder paths", () => {
  const expected = {
    nodePath: "/opt/node/bin/node",
    entrypointPath: "/tmp/user prefix/lib/node_modules/worktree-switcher/dist/cli/index.js",
    packageRoot: "/tmp/user prefix/lib/node_modules/worktree-switcher",
    dataDirectory: "/tmp/data",
    stateDirectory: "/tmp/state",
    webRoot: "/tmp/user prefix/lib/node_modules/worktree-switcher/out",
    forbiddenPaths: ["/home/runner/work/repository"],
  };
  const definition = [
    `ExecStart="${expected.nodePath}" "${expected.entrypointPath}" "start" "--data-dir" "${expected.dataDirectory}" "--state-dir" "${expected.stateDirectory}" "--web-root" "${expected.webRoot}"`,
    "WorkingDirectory=/tmp/user prefix/lib/node_modules/worktree-switcher",
    "KillMode=control-group",
    "WantedBy=default.target",
  ].join("\n");
  assert.deepEqual(inspectSystemdDefinition(definition, expected), { requiredFragments: 8, builderPathsAbsent: true });
  assert.throws(() => inspectSystemdDefinition(`${definition}\n/home/runner/work/repository`, expected), /builder path/);
  assert.throws(() => inspectSystemdDefinition(definition.replace("WantedBy=default.target", ""), expected), /missing/);
});
