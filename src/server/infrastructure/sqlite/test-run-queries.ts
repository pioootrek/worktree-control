import type { PendingTestRun, TestRunStatusRecord, TestRunRequester, HumanTestRunRequester, VerificationRequester } from "@/server/state-store";
import type { TestEnvironmentMode, TestRun, TestRunPhase } from "@/shared/contracts";
import Database from "better-sqlite3";
import { humanTestRequesterSchema, emptyTelemetry, emptyRunResources, resourceReason, type TestRunAdministrationAuditEntry, type TestRunAdministrationRecord } from "@/server/modules/verification";
import { TestSummaryQueries } from "./test-summary-queries";
import { legacySourceEvidence } from "@/server/test-source-attribution";

export type TestRunRow = {
  id: string;
  project_id: string;
  worktree_path: string;
  worktree_head: string;
  worktree_branch: string | null;
  worktree_dirty: number;
  preset_id: string;
  preset_name: string;
  adapter: TestRun["adapter"];
  actor: string;
  phase: TestRunPhase;
  queue_position: number | null;
  executable: string;
  args_json: string;
  cwd: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  logs_json: string;
  idempotency_key: string | null;
  environment_mode: TestEnvironmentMode;
  environment_profile: string;
  inherited_server_profile: string | null;
  environment_variable_names_json: string;
  source_json: string | null;
  telemetry_json: string | null;
};

export function mapTestRun(row: TestRunRow): TestRun {
  const telemetry = row.telemetry_json ? JSON.parse(row.telemetry_json) as NonNullable<TestRun["telemetry"]> : emptyTelemetry();
  telemetry.resources ??= emptyRunResources();
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    worktreeHead: row.worktree_head,
    worktreeBranch: row.worktree_branch,
    worktreeDirty: row.worktree_dirty === 1,
    presetId: row.preset_id,
    presetName: row.preset_name,
    adapter: row.adapter,
    actor: row.actor,
    phase: row.phase,
    queuePosition: row.queue_position,
    executable: row.executable,
    args: JSON.parse(row.args_json) as string[],
    cwd: row.cwd,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    signal: row.signal,
    error: row.error,
    logs: JSON.parse(row.logs_json) as string[],
    environmentMode: row.environment_mode,
    environmentProfile: row.environment_profile,
    inheritedServerProfile: row.inherited_server_profile,
    environmentVariableNames: JSON.parse(row.environment_variable_names_json) as string[],
    telemetry,
    source: row.source_json ? JSON.parse(row.source_json) as TestRun["source"] : legacySourceEvidence(),
  };
}

/** Borrows the owner connection; never opens or closes a database. */
export class TestRunQueries {
  constructor(private readonly database: Database.Database) {}

  countTestRuns(phases: TestRunPhase[], projectId?: string, worktreePath?: string): number {
    if (phases.length === 0) return 0;
    const conditions = [`phase IN (${phases.map(() => "?").join(", ")})`];
    const parameters: string[] = [...phases];
    if (projectId) {
      conditions.push("project_id = ?");
      parameters.push(projectId);
    }
    if (worktreePath) {
      conditions.push("worktree_path = ?");
      parameters.push(worktreePath);
    }
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM test_runs WHERE ${conditions.join(" AND ")}`)
      .get(...parameters) as { count: number };
    return row.count;
  }

  listPendingTestRuns(): PendingTestRun[] {
    return this.database.prepare(`
      SELECT id, project_id AS projectId, worktree_path AS worktreePath, phase,
             queue_position AS queuePosition, queued_at AS queuedAt
      FROM test_runs
      WHERE phase IN ('queued', 'running')
      ORDER BY queued_at ASC, id ASC
    `).all() as PendingTestRun[];
  }

  listTestRuns(projectId?: string, limit = 50): TestRun[] {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = projectId
      ? this.database.prepare("SELECT * FROM test_runs WHERE project_id = ? ORDER BY CASE WHEN phase IN ('queued', 'running') THEN 0 ELSE 1 END, queued_at DESC, id DESC LIMIT ?").all(projectId, boundedLimit)
      : this.database.prepare("SELECT * FROM test_runs ORDER BY CASE WHEN phase IN ('queued', 'running') THEN 0 ELSE 1 END, queued_at DESC, id DESC LIMIT ?").all(boundedLimit);
    return (rows as TestRunRow[]).map(mapTestRun);
  }

  hasTestRun(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM test_runs WHERE id = ?").get(id) !== undefined;
  }

  getTestRun(id: string): TestRun | null {
    const row = this.database.prepare("SELECT * FROM test_runs WHERE id = ?").get(id) as TestRunRow | undefined;
    return row ? mapTestRun(row) : null;
  }

  getTestRunStatus(id: string): TestRunStatusRecord | null {
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, worktree_path AS worktreePath,
             worktree_head AS worktreeHead, worktree_branch AS worktreeBranch,
             worktree_dirty AS worktreeDirty, preset_id AS presetId, phase,
             queue_position AS queuePosition, queued_at AS queuedAt,
             started_at AS startedAt, finished_at AS finishedAt,
             exit_code AS exitCode, signal, error, source_json AS sourceJson
      FROM test_runs WHERE id = ?
    `).get(id) as (Omit<TestRunStatusRecord, "worktreeDirty" | "source"> & { worktreeDirty: number; sourceJson: string | null }) | undefined;
    if (!row) return null;
    const { sourceJson, ...status } = row;
    return {
      ...status,
      worktreeDirty: row.worktreeDirty === 1,
      source: sourceJson ? JSON.parse(sourceJson) as TestRun["source"] : legacySourceEvidence(),
    };
  }

  findTestRunByIdempotency(actor: string, idempotencyKey: string): TestRun | null {
    const row = this.database.prepare("SELECT * FROM test_runs WHERE actor = ? AND idempotency_key = ?")
      .get(actor, idempotencyKey) as TestRunRow | undefined;
    if (!row && actor.startsWith("human:test:") && this.database.prepare("SELECT 1 FROM human_test_run_intents WHERE principal_id=? AND idempotency_key=? AND retain_until>?")
      .get(actor.slice("human:test:".length), idempotencyKey, new Date().toISOString())) throw new Error("Original test intent is retained without run details.");
    return row ? mapTestRun(row) : null;
  }

  getTestRunRequester(id: string): TestRunRequester | null {
    return this.database.prepare(`SELECT principal_id AS principalId, credential_id AS credentialId,
      project_id AS projectId, session_owner AS sessionOwner, reservation_id AS reservationId,
      lease_token_hash AS leaseTokenHash FROM test_run_requesters WHERE run_id=?`).get(id) as TestRunRequester | undefined ?? null;
  }

  getHumanTestRunRequester(id: string): HumanTestRunRequester | null {
    const run = this.database.prepare("SELECT provider_bound,actor,project_id,idempotency_key FROM test_runs WHERE id=?").get(id) as {provider_bound:number;actor:string;project_id:string;idempotency_key:string|null} | undefined;
    const row = this.database.prepare(`SELECT project_id AS projectId,session_owner AS sessionOwner,principal_id AS principalId,
      authority_json AS authority,reference_json AS reference,reservation_id AS reservationId,fingerprint
      FROM human_test_run_requesters WHERE run_id=?`).get(id) as {projectId:string;sessionOwner:string;principalId:string;authority:string;reference:string;reservationId:string|null;fingerprint:string} | undefined;
    if (!row && !run?.provider_bound) return null;
    try {
      if (!row || run?.provider_bound !== 1 || run.actor !== row.sessionOwner || run.project_id !== row.projectId
        || this.getTestRunRequester(id)) throw new Error();
      const parsed = humanTestRequesterSchema.parse({ kind: "human", projectId: row.projectId, sessionOwner: row.sessionOwner,
        authority: JSON.parse(row.authority), reference: JSON.parse(row.reference), reservationId: row.reservationId, fingerprint: row.fingerprint });
      const intent = this.database.prepare("SELECT principal_id,session_key,fingerprint,retain_until,idempotency_key FROM human_test_run_intents WHERE run_id=?").get(id) as {principal_id:string;session_key:string;fingerprint:string;retain_until:string;idempotency_key:string} | undefined;
      if (parsed.authority.principalId !== row.principalId || (!intent && parsed.authority.deadline > new Date().toISOString())
        || (intent && (intent.principal_id !== row.principalId || intent.session_key !== parsed.authority.sessionKey
          || intent.fingerprint !== parsed.fingerprint || intent.retain_until !== parsed.authority.deadline || intent.idempotency_key !== run.idempotency_key))) throw new Error();
      return parsed;
    } catch { throw new Error("Human test attribution is unavailable."); }
  }

  saveTestRun(run: TestRun, idempotencyKey?: string, requester?: VerificationRequester): void {
    this.database.transaction(() => {
      // Attribution is insert-only and atomic with the first run write.
      if (requester && this.hasTestRun(run.id)) throw new Error("Test requester is immutable.");
      this.saveRunAndSummary(run, idempotencyKey);
      if (requester && "kind" in requester) {
        const parsed = humanTestRequesterSchema.parse(requester);
        if (parsed.projectId !== run.projectId || parsed.sessionOwner !== run.actor) throw new Error("Invalid test requester.");
        if (!idempotencyKey || idempotencyKey.length > 120) throw new Error("Human test intent requires an idempotency key.");
        this.database.prepare("DELETE FROM human_test_run_intents WHERE retain_until<=?").run(new Date().toISOString());
        const total = (this.database.prepare("SELECT count(*) n FROM human_test_run_intents").get() as {n:number}).n;
        const session = (this.database.prepare("SELECT count(*) n FROM human_test_run_intents WHERE session_key=?").get(parsed.authority.sessionKey) as {n:number}).n;
        if (total >= 4096 || session >= 128) throw new Error("Human test intent capacity is exhausted.");
        this.database.prepare(`INSERT INTO human_test_run_intents(principal_id,idempotency_key,session_key,run_id,fingerprint,retain_until) VALUES(?,?,?,?,?,?)`)
          .run(parsed.authority.principalId,idempotencyKey,parsed.authority.sessionKey,run.id,parsed.fingerprint,parsed.authority.deadline);
        this.database.prepare("UPDATE test_runs SET provider_bound=1 WHERE id=?").run(run.id);
        this.database.prepare(`INSERT INTO human_test_run_requesters
          (run_id,project_id,principal_id,session_owner,authority_json,reference_json,reservation_id,fingerprint)
          VALUES (?,?,?,?,?,?,?,?)`).run(run.id,parsed.projectId,parsed.authority.principalId,parsed.sessionOwner,
            JSON.stringify(parsed.authority),JSON.stringify(parsed.reference),parsed.reservationId,parsed.fingerprint);
      } else if (requester) {
        if (requester.projectId !== run.projectId || requester.sessionOwner !== run.actor) throw new Error("Invalid test requester.");
        this.database.prepare(`INSERT INTO test_run_requesters
          (run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash)
          VALUES (?,?,?,?,?,?,?)`).run(run.id, requester.principalId, requester.credentialId,
            requester.projectId, requester.sessionOwner, requester.reservationId, requester.leaseTokenHash);
      }
    })();
  }

  private saveRunAndSummary(run: TestRun, idempotencyKey?: string): void {
    this.database.prepare(`
      INSERT INTO test_runs (
        id, project_id, worktree_path, worktree_head, worktree_branch, worktree_dirty,
        preset_id, preset_name, adapter, actor, phase, queue_position, executable,
        args_json, cwd, queued_at, started_at, finished_at, exit_code, signal, error,
        logs_json, idempotency_key, environment_mode, environment_profile,
        inherited_server_profile, environment_variable_names_json, source_json, telemetry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase, queue_position = excluded.queue_position,
        executable = excluded.executable, args_json = excluded.args_json, cwd = excluded.cwd,
        environment_variable_names_json = excluded.environment_variable_names_json,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        exit_code = excluded.exit_code, signal = excluded.signal, error = excluded.error,
        logs_json = excluded.logs_json, source_json = excluded.source_json, telemetry_json = excluded.telemetry_json
    `).run(
      run.id, run.projectId, run.worktreePath, run.worktreeHead, run.worktreeBranch,
      run.worktreeDirty ? 1 : 0, run.presetId, run.presetName, run.adapter, run.actor,
      run.phase, run.queuePosition, run.executable, JSON.stringify(run.args), run.cwd, run.queuedAt,
      run.startedAt, run.finishedAt, run.exitCode, run.signal, run.error,
      JSON.stringify(run.logs), idempotencyKey ?? null, run.environmentMode, run.environmentProfile,
      run.inheritedServerProfile, JSON.stringify(run.environmentVariableNames), JSON.stringify(run.source), JSON.stringify(run.telemetry ?? emptyTelemetry()),
    );
    const summaries = new TestSummaryQueries(this.database);
    summaries.save(run);
    if (["passed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.phase)
      && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || run.telemetry.finalizedAt || run.telemetry.recoveredAt)) {
      summaries.prune(run.projectId);
      // Keep remote completion evidence until its immutable report is durable,
      // even if networking is stalled. At most 1000 receipts can pin extra rows.
      this.database.prepare(`
        DELETE FROM test_runs WHERE id IN (
          SELECT id FROM test_runs WHERE project_id = ? AND phase NOT IN ('queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM test_run_summaries s WHERE s.run_id=test_runs.id AND s.terminal=0)
          ORDER BY queued_at DESC, id DESC LIMIT -1 OFFSET 50
        )
        AND id NOT IN (
          SELECT json_extract(payload_json, '$.localRunId') FROM remote_worker_receipts
          WHERE json_extract(payload_json, '$.localRunId') IS NOT NULL
          AND coalesce(json_extract(payload_json, '$.reports[#-1].phase'), '')
            NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain')
        )
      `).run(run.projectId);
    }
  }

  pruneTestSummaryHistory(): number {
    return this.database.transaction(() => new TestSummaryQueries(this.database).prune())();
  }

  /** Append-only local-administrator audit in the shared controller audit table. Details are bounded by the caller's validation. */
  recordTestRunAdministration(entry: TestRunAdministrationAuditEntry): void {
    const { event, ...details } = entry;
    this.database.prepare("INSERT INTO controller_audit_events(event_type, actor, details_json, created_at) VALUES (?, 'local-admin', ?, ?)")
      .run(event, JSON.stringify(details), new Date().toISOString());
  }

  /** Newest administrator events for one exact run ID; bounded by `limit`. */
  listTestRunAdministration(runId: string, limit: number): TestRunAdministrationRecord[] {
    const rows = this.database.prepare(`
      SELECT event_type, details_json, created_at FROM controller_audit_events
      WHERE event_type IN ('test_run.admin_stop_requested', 'test_run.admin_stop_result')
        AND json_valid(details_json) AND json_extract(details_json, '$.runId') = ?
      ORDER BY id DESC LIMIT ?
    `).all(runId, Math.max(1, Math.min(limit, 50))) as { event_type: TestRunAdministrationAuditEntry["event"]; details_json: string; created_at: string }[];
    return rows.map(row => {
      const details = JSON.parse(row.details_json) as Omit<TestRunAdministrationAuditEntry, "event">;
      return { ...details, operator: details.operator ?? null, event: row.event_type, at: row.created_at };
    });
  }

  markInterruptedTestRuns(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const pending = this.database.prepare("SELECT * FROM test_runs WHERE phase IN ('queued', 'running') OR id IN (SELECT run_id FROM test_run_summaries WHERE terminal=0)").all() as TestRunRow[];
      for (const row of pending) {
        const run = mapTestRun(row);
        run.source.processOutcome ??= "interrupted";
        if (run.source.attribution === "pending") run.source.attribution = "uncertain";
        run.source.reasonCodes = [...new Set([...run.source.reasonCodes, "controller_interrupted"])].slice(0, 12);
        run.phase = "interrupted";
        run.finishedAt = now;
        run.queuePosition = null;
        run.error = "Kontroler został zatrzymany przed zakończeniem testu.";
        run.telemetry ??= emptyTelemetry();
        if (run.telemetry.availability !== "legacy_unknown") run.telemetry.availability = "partial";
        if (run.telemetry.resources && run.telemetry.resources.status !== "legacy_unknown") {
          const resources = run.telemetry.resources;
          if (resources.status !== "unsupported") resources.status = resources.sampleCount ? "partial" : "unavailable";
          resourceReason(resources, "controller_interrupted");
        }
        run.telemetry.termination = "interruption";
        run.telemetry.recoveredAt = now;
        // Recovery cannot observe the lost process's exit, cleanup or monotonic intervals.
        this.saveRunAndSummary(run);
      }
      this.database.prepare(`
        DELETE FROM test_runs WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY queued_at DESC, id DESC) AS rank
            FROM test_runs WHERE phase NOT IN ('queued', 'running')
          ) WHERE rank > 50
        )
      `).run();
    })();
  }
}
