import { describe, expect, it } from "vitest";

import type { TestRun } from "@/shared/contracts";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { emptyTelemetry } from "./run-telemetry";
import { administrativeStopAction, nextStep, resolveRun, type TestRunOwnershipEvidence } from "./run-ownership";

function run(overrides: Partial<TestRun> = {}, telemetry: Partial<NonNullable<TestRun["telemetry"]>> = {}): TestRun {
  return {
    id: "run-1", projectId: "project-1", worktreePath: "/code/app", worktreeHead: "abc", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "agent:mcp:session-secret", phase: "running", queuePosition: null,
    executable: "pnpm", args: ["test"], cwd: "/code/app", queuedAt: "2026-11-12T00:00:00.000Z", startedAt: null, finishedAt: null,
    exitCode: null, signal: null, error: null, logs: [], environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null,
    environmentVariableNames: [], source: legacySourceEvidence(),
    telemetry: { ...emptyTelemetry("observed"), ...telemetry },
    ...overrides,
  };
}

function evidence(overrides: Partial<TestRunOwnershipEvidence> = {}): TestRunOwnershipEvidence {
  return {
    run: run(), ownedProcess: { exited: false, stopping: false, cancellationRequested: false, timedOut: false },
    preparing: false, preparationActive: false, preparationCleanupUnconfirmed: false, finalizing: false, queueClosed: false,
    admissionBlockReason: null, ...overrides,
  };
}

const owned = (state: Partial<NonNullable<TestRunOwnershipEvidence["ownedProcess"]>> = {}) => ({
  exited: false, stopping: false, cancellationRequested: false, timedOut: false, ...state,
});

describe("administrator run ownership policy", () => {
  it.each([
    ["queued", evidence({ run: run({ phase: "queued" }), ownedProcess: null }), "pending", "queued", "cancel"],
    ["source preflight", evidence({ run: run({ phase: "queued" }), ownedProcess: null, preparing: true }), "pending", "preparing", "cancel"],
    ["preparation already stopping", evidence({ run: run({ phase: "queued" }, { stopRequestedAt: "t" }), ownedProcess: null, preparing: true }), "pending", "stop_in_progress", "join"],
    ["owned live process", evidence(), "pending", "running", "cancel"],
    ["owned process being stopped", evidence({ ownedProcess: owned({ stopping: true, cancellationRequested: true }) }), "pending", "stop_in_progress", "join"],
    ["owned cleanup failed after cancel", evidence({ run: run({}, { cleanup: "failed" }), ownedProcess: owned({ cancellationRequested: true }) }), "unresolved", "process_cleanup_unconfirmed", "cleanup_retry"],
    ["owned cleanup failed after natural exit", evidence({ run: run({ exitCode: 0 }, { cleanup: "failed" }), ownedProcess: owned({ exited: true }) }), "unresolved", "process_cleanup_unconfirmed", "cleanup_retry"],
    ["running record without owned group", evidence({ ownedProcess: null }), "unresolved", "ownership_unknown", "none"],
    ["terminal, process finalizing", evidence({ run: run({ phase: "passed" }), finalizing: true }), "pending", "finalizing", "join"],
    ["terminal before finalization starts", evidence({ run: run({ phase: "failed" }), ownedProcess: owned({ exited: true, stopping: true }) }), "pending", "finalizing", "join"],
    ["confirmed cleanup", evidence({ run: run({ phase: "failed", exitCode: 3 }, { cleanup: "confirmed", finalizedAt: "t", spawnedAt: "t" }), ownedProcess: null }), "confirmed", "finalized", "none"],
    ["pre-spawn cancellation", evidence({ run: run({ phase: "cancelled" }, { cleanup: "not_required", finalizedAt: "t" }), ownedProcess: null }), "confirmed", "finalized", "none"],
    ["not_required after a spawn", evidence({ run: run({ phase: "cancelled" }, { cleanup: "not_required", finalizedAt: "t", spawnedAt: "t" }), ownedProcess: null }), "unresolved", "cleanup_evidence_unavailable", "none"],
    ["terminal without finalization", evidence({ run: run({ phase: "passed" }, { cleanup: "confirmed" }), ownedProcess: null }), "unresolved", "cleanup_evidence_unavailable", "none"],
    ["legacy record", evidence({ run: run({ phase: "passed" }, { availability: "legacy_unknown", finalizedAt: "t", cleanup: "confirmed" }), ownedProcess: null }), "unresolved", "cleanup_evidence_unavailable", "none"],
    ["startup recovery", evidence({ run: run({ phase: "interrupted" }, { recoveredAt: "t", finalizedAt: "t", cleanup: "confirmed" }), ownedProcess: null }), "unresolved", "ownership_lost_after_restart", "none"],
    ["workspace disposal failure", evidence({ run: run({ phase: "interrupted", error: "workspace_cleanup_failed" }, { cleanup: "failed", finalizedAt: "t" }), ownedProcess: owned({ exited: true }), preparationCleanupUnconfirmed: true }), "unresolved", "workspace_cleanup_failed", "none"],
    ["remote preparation cleanup", evidence({ run: run({ phase: "interrupted", error: "preparation_cleanup_unconfirmed" }, { cleanup: "failed", finalizedAt: "t" }), ownedProcess: null, preparing: true, preparationCleanupUnconfirmed: true }), "unresolved", "preparation_cleanup_unconfirmed", "none"],
  ] as const)("%s", (_label, input, state, reason, action) => {
    expect(resolveRun(input)).toEqual({ state, reason });
    expect(administrativeStopAction(input)).toBe(action);
    expect(nextStep(reason, input.run.id)).not.toMatch(/session-secret/);
  });

  it("never treats a missing record as quiescence", () => {
    expect(resolveRun(null)).toEqual({ state: "unresolved", reason: "run_not_found" });
    expect(nextStep("run_not_found", "x")).toContain("not evidence");
  });

  it("does not propose an effect for a queued run whose remote cleanup is unconfirmed", () => {
    expect(administrativeStopAction(evidence({ run: run({ phase: "queued" }), ownedProcess: null, preparationCleanupUnconfirmed: true }))).toBe("none");
  });
});
