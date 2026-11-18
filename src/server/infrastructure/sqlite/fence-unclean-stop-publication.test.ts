import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Fault = {
  operation: string; phase: string; step: string; errno: string; persistence: string;
  before: Disk; after: Disk; afterRetry: Disk;
  first: Outcome; retry: Outcome; read: Outcome;
  injections: Array<{ publication: string; step: string; code: string }>;
  attempts: Array<{ outcome: Outcome; disk: Disk }>;
  newProcessAfterFailure: Probe; newProcessAfterRetry: Probe;
  newProcessAfterClose: { opened: boolean; error?: { code: string } };
};
type Outcome = { success: boolean; error: null | { code: string; committed: boolean } };
type Disk = { epoch: string; rowHash: string; witness: { state: string; epoch: string }; temporaries: string[] };
type Probe = { inspect: { accepted: boolean; error?: { code: string } }; openWhileOwnerAlive: { opened: boolean } };
type Measurement = {
  measurement: string; directory: string; filesystem: { type: number };
  aMs: { n: number }; bMs: { n: number }; totalMs: { n: number };
  aShare: number; bShare: number;
  samples: Array<{ aMs: number; bMs: number; totalMs: number }>;
};
const helper = resolve("scripts/fence-unclean-stop-publication.ts");
const evidenceRoot = join(homedir(), ".local/state/worktree-control-auth-unification/fence-13e00db3");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidencePath = join(evidenceRoot, `fence-part2-${head.slice(0, 8)}-${Date.now()}.json`);
const evidence: { head: string; generatedAt: string; measurements: unknown[]; faults: unknown[]; commitFailures: unknown[]; notes: string[] } = {
  head, generatedAt: new Date().toISOString(), measurements: [], faults: [], commitFailures: [], notes: [
    "Synthetic data only. No actual disk exhaustion, mount changes, development server or production-source changes.",
    "Visibility timestamps are immediately after renameSync returns; native COMMIT/autocommit timestamps are immediately after Statement.run returns.",
    "200 samples per operation and filesystem after 20 warmups. Shares are sum(segment)/sum(window), not ratios of separate medians.",
    "Close faults are thrown after the real close, so descriptors are not leaked by the injector.",
    "A new read-only process invokes production SecurityFence.inspect while the owner lives; full opening separately reports the ownership lock. Full opening is repeated after owner close.",
    "The SQLITE_FULL case throws at the native COMMIT call boundary before invoking COMMIT; real SQLite rollback follows. It does not simulate a VFS or actual engine I/O failure.",
    "fallback-open keeps temporary-file creation failing after the selected confirmed-publication error. This also covers a post-rename sync failure followed by inability to republish pending.",
    "Publication coverage: O_EXCL temporary open; writeFileSync; file fsync; file close; rename; directory open; directory fsync; directory close. Validation and successful cleanup calls remain active.",
  ],
};
function save() {
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log("FENCE_PART2_EVIDENCE", evidencePath);
}
async function child<T>(...args: string[]): Promise<T> {
  const child = spawn(process.execPath, ["--import", "tsx", helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect({ ...exit, stderr }, stdout).toEqual({ code: 0, signal: null, stderr: "" });
    return JSON.parse(stdout.trim()) as T;
  } finally { clearTimeout(timer); }
}
function fixture(base = tmpdir()) {
  const root = mkdtempSync(join(base, "fence-part2-"));
  writeFileSync(join(root, "synthetic-only"), "synthetic test installation");
  return root;
}
const steps = ["open-temp", "write-temp", "fsync-temp", "close-temp", "rename", "open-directory", "fsync-directory", "close-directory"];
describe.sequential("fence publication failure observation (no production changes)", () => {
  it("separates native commit return from the two witness visibility boundaries", async () => {
    const diskBase = join(evidenceRoot, "disk-fixtures");
    mkdirSync(diskBase, { recursive: true, mode: 0o700 });
    try {
      for (const base of [tmpdir(), diskBase]) for (const operation of ["bearer", "test-persist"]) {
        const root = fixture(base);
        try {
          const result = await child<Measurement>("measure", root, operation);
          evidence.measurements.push(result); save();
          for (const segment of [result.aMs, result.bMs, result.totalMs]) expect(segment.n).toBe(200);
          expect(result.aShare + result.bShare).toBeCloseTo(1, 12);
          for (const sample of result.samples) {
            expect(sample.aMs).toBeGreaterThan(0); expect(sample.bMs).toBeGreaterThan(0);
            expect(sample.aMs + sample.bMs).toBeCloseTo(sample.totalMs, 12);
          }
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
    } finally { rmSync(diskBase, { recursive: true, force: true }); }
  }, 90_000);
  it("records ENOSPC and EIO at every publication I/O step, retries, reads and new-process admission", async () => {
    for (const operation of ["bearer", "test-persist"]) for (const phase of ["pending", "confirmed"])
      for (const step of steps) for (const errno of ["ENOSPC", "EIO"]) {
        const root = fixture();
        try {
          const result = await child<Fault>("fault", root, operation, phase, step, errno, "persistent");
          evidence.faults.push(result); save();
          expect(result.injections).toEqual([{ publication: phase, step, code: errno }]);
          expect(result.first).toMatchObject({ success: false, error: { code: "security_fence_pending", committed: phase === "confirmed" } });
          expect(result.after.epoch === result.before.epoch).toBe(phase === "pending");
          expect(result.after.rowHash === result.before.rowHash).toBe(phase === "pending");
          const beforeRename = ["open-temp", "write-temp", "fsync-temp", "close-temp", "rename"].includes(step);
          const accepted = phase === "pending" && beforeRename;
          expect(result.after.witness).toEqual({ state: accepted ? "confirmed" : "pending", epoch: result.before.epoch });
          expect(result.after.temporaries).toEqual([]);
          expect(result.retry).toMatchObject({ success: false, error: { code: "security_fence_pending" } });
          expect(result.afterRetry).toEqual(result.after);
          expect(result.read).toMatchObject({ success: false, error: { code: "security_fence_pending" } });
          expect(result.attempts).toHaveLength(4);
          for (const attempt of result.attempts.slice(1)) {
            expect(attempt.outcome).toMatchObject({ success: false, error: { code: "security_fence_pending", committed: false } });
            expect(attempt.disk).toEqual(result.after);
          }
          for (const probe of [result.newProcessAfterFailure, result.newProcessAfterRetry]) {
            expect(probe.inspect.accepted).toBe(accepted);
            if (!accepted) expect(probe.inspect.error?.code).toBe("security_fence_recovery_required");
            expect(probe.openWhileOwnerAlive.opened).toBe(false);
          }
          expect(result.newProcessAfterClose.opened).toBe(accepted);
          if (!accepted) expect(result.newProcessAfterClose.error?.code).toBe("security_fence_recovery_required");
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
  }, 600_000);
  it("keeps the same filesystem fault active during confirmation's pending fallback", async () => {
    for (const operation of ["bearer", "test-persist"]) for (const step of steps) for (const errno of ["ENOSPC", "EIO"]) {
      const root = fixture();
      try {
        const result = await child<Fault>("fault", root, operation, "confirmed", step, errno, "all-publications");
        evidence.faults.push(result); save();
        expect(result.injections).toEqual([{ publication: "confirmed", step, code: errno }, { publication: "pending", step, code: errno }]);
        expect(result.first).toMatchObject({ success: false, error: { code: "security_fence_pending", committed: true } });
        expect(result.after.epoch).not.toBe(result.before.epoch);
        expect(result.after.rowHash).not.toBe(result.before.rowHash);
        expect(result.after.witness).toEqual({ state: "pending", epoch: result.before.epoch });
        expect(result.after.temporaries).toEqual([]);
        expect(result.retry.success).toBe(false);
        expect(result.read.success).toBe(false);
        expect(result.afterRetry).toEqual(result.after);
        expect(result.newProcessAfterFailure.inspect.error?.code).toBe("security_fence_recovery_required");
        expect(result.newProcessAfterRetry.inspect.error?.code).toBe("security_fence_recovery_required");
        expect(result.newProcessAfterClose.error?.code).toBe("security_fence_recovery_required");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 300_000);
  it("records a lasting inability to create the fallback temporary after confirmation fails", async () => {
    for (const operation of ["bearer", "test-persist"]) for (const step of steps) for (const errno of ["ENOSPC", "EIO"]) {
      const root = fixture();
      try {
        const result = await child<Fault>("fault", root, operation, "confirmed", step, errno, "fallback-open");
        evidence.faults.push(result); save();
        expect(result.injections).toEqual([{ publication: "confirmed", step, code: errno }, { publication: "pending", step: "open-temp", code: errno }]);
        expect(result.first).toMatchObject({ success: false, error: { code: "security_fence_pending", committed: true } });
        const renamed = ["open-directory", "fsync-directory", "close-directory"].includes(step);
        expect(result.after.epoch).not.toBe(result.before.epoch);
        expect(result.after.witness).toEqual(renamed
          ? { state: "confirmed", epoch: result.after.epoch } : { state: "pending", epoch: result.before.epoch });
        expect(result.after.temporaries).toEqual([]);
        expect(result.retry.success).toBe(false); expect(result.read.success).toBe(false);
        expect(result.afterRetry).toEqual(result.after);
        expect(result.newProcessAfterFailure.inspect.accepted).toBe(renamed);
        expect(result.newProcessAfterRetry.inspect.accepted).toBe(renamed);
        expect(result.newProcessAfterClose.opened).toBe(renamed);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 300_000);
  it("records a synthetic SQLITE_FULL refusal before native COMMIT and the real rollback path", async () => {
    for (const persistence of ["once", "persistent"]) {
      const root = fixture();
      try {
        const result = await child<Fault>("commit-fail", root, "test-persist", "sqlite", "commit", "SQLITE_FULL", persistence);
        evidence.commitFailures.push(result); save();
        expect(result.first).toMatchObject({ success: false, error: { code: "SQLITE_FULL", committed: false } });
        expect(result.after.epoch).toBe(result.before.epoch);
        expect(result.after.rowHash).toBe(result.before.rowHash);
        expect(result.after.witness).toEqual({ state: "confirmed", epoch: result.before.epoch });
        expect(result.injections).toHaveLength(persistence === "once" ? 1 : 4);
        expect(result.read.success).toBe(true);
        expect(result.retry.success).toBe(true);
        expect(result.afterRetry.witness).toEqual({ state: "confirmed", epoch: result.afterRetry.epoch });
        expect(result.newProcessAfterFailure.inspect.accepted).toBe(true);
        expect(result.newProcessAfterRetry.inspect.accepted).toBe(true);
        expect(result.newProcessAfterClose.opened).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 60_000);
});
