import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const operations = ["bearer", "test-persist", "claim", "renew", "release", "expiry", "human-intent", "human-claim", "human-renew", "human-release", "settings", "project", "knowledge-project", "grant", "worker-contact", "vault", "provider-session-storage", "session-issuance", "factor-step", "factor-budget", "factor-receipt", "installation-token", "remote-submit", "remote-assign", "remote-cancel", "remote-report", "worker-receipt", "human-test", "agent-test", "runtime-credential", "membership", "factor-reset", "passkey-stage", "provider-sign-in"];
const evidence: unknown[] = [];
function record(kind: string, value: unknown) {
  evidence.push({ kind, value });
  const path = join(tmpdir(), "fence-investigation-evidence.json");
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log(kind, JSON.stringify(value));
  console.log("FENCE_EVIDENCE", path);
}
const helper = resolve("scripts/fence-unclean-stop.ts");
async function child(...args: string[]) {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", chunk => { stdout += chunk; });
  process.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => process.kill("SIGKILL"), 30_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      process.once("error", reject); process.once("exit", (code, signal) => resolve({code,signal}));
    });
    return { ...exit, stderr, records: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  } finally { clearTimeout(timer); }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fence-investigation-"));
  writeFileSync(join(root, "synthetic-only"), "synthetic installation owned by this test");
  return root;
}
describe.sequential("released fence unclean-stop investigation (no production changes)", () => {
  it("records each storage traffic class, both sides of commit, outside-window controls, SIGTERM and recovery", async () => {
    for (const operation of operations) {
      for (const edge of ["before-pending", "before-row", "after-commit", "after-confirmed"]) {
        const root = fixture();
        try {
          const killed = await child("write", root, operation, edge);
          expect(killed.stderr, `${operation}/${edge}`).toBe("");
          expect(killed.signal, `${operation}/${edge}: ${JSON.stringify(killed)}`).toBe("SIGKILL");
          const before = JSON.parse(readFileSync(join(root, "before.json"), "utf8"));
          const state = await child("snapshot", root);
          expect(state.code).toBe(0);
          const after = state.records[0];
          const beforeCommit = ["before-pending", "before-row"].includes(edge);
          expect(JSON.stringify(after.checkpoint) === JSON.stringify(before.checkpoint)).toBe(beforeCommit);
          const changed = Object.keys(before.tables).filter(table => before.tables[table].hash !== after.tables[table].hash);
          expect(changed.length === 0).toBe(beforeCommit);
          const opened = await child("open", root);
          const inside = ["before-row", "after-commit"].includes(edge);
          expect(opened.code).toBe(inside ? 23 : 0);
          expect(opened.stderr).toBe("");
          if (inside) expect(opened.records[0].code).toBe("security_fence_recovery_required");
          record("FENCE_CASE", { operation, edge, kill: killed.signal, opening: opened, database: beforeCommit ? "before" : "after", changed });
          if (operation === "bearer" && edge === "after-commit") {
            const recovered = await child("recover", root);
            expect(recovered.code, JSON.stringify(recovered)).toBe(0);
            expect(recovered.records.find(r => r.resume)?.resume).toMatchObject({ trusted: true, quarantined: true });
            const recovery = recovered.records.find(r => r.recovery)!.recovery;
            expect(recovery.after.authority.credentials.active).toBe(0);
            expect(recovery.after.authority.passwords.passwords).toBe(0);
            expect(recovery.after.tables.authentication_ba_session.count).toBe(0);
            record("FENCE_RECOVERY", recovered.records);
            expect((await child("open", root)).code).toBe(0);
          }
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
    for (const operation of ["bearer", "test-persist", "provider-session-storage"]) {
      for (const edge of ["before-row", "after-commit"]) {
        const root = fixture();
        try {
          const stopped = await child("write", root, operation, edge, "SIGTERM");
          expect(stopped.code, JSON.stringify(stopped)).toBe(0);
          expect(stopped.records.some(r => r.graceful)).toBe(true);
          const opened = await child("open", root);
          expect(opened.code).toBe(0);
          record("FENCE_TERM", { operation, edge, stopped, opened });
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }, 600_000);
  it("measures 200 post-warmup windows for bearer authentication and test-run persistence", async () => {
    for (const operation of ["bearer", "test-persist"]) {
      const root = fixture();
      try {
        const result = await child("measure", root, operation);
        expect(result.code, JSON.stringify(result)).toBe(0);
        const measurement = result.records.find(r => r.measurement);
        expect(measurement?.publication.n).toBe(200);
        expect(measurement?.visible.n).toBe(200);
        record("FENCE_MEASURE", measurement);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 60_000);
});
