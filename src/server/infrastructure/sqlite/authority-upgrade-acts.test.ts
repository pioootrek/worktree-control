import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup } from "../../controller-backup";
import { IdentityService, type AuthenticatedPrincipal } from "../../modules/identity";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { SqliteStateStore } from "./sqlite-state-store";
import { SecurityFence, SecurityFenceError, securityFenceRoot } from "./security-fence";
import { maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { hashFile } from "./backup-validation";
import { schemaTarget, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { applyMappingQuarantine, planMappingQuarantine } from "./mapping-structure-migration";
import { TestRunQueries } from "./test-run-queries";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup, type UpgradeBackupSource } from "./upgrade-maintenance";
import { canonicalJson, normaliseUpgradeDecisions, upgradePlanPath, validateUpgradeProposal, type UpgradeAct, type UpgradePlan } from "./upgrade-plan";
import {
  AUTHORITY_ACT_DOMAIN, AUTHORITY_KEPT, AUTHORITY_OWNER_LIMIT, AUTHORITY_STORED_COLUMNS, GRANT_ADMIN, normaliseAuthorityDecisions, proposeAuthority, RELEASE_RUNNING_WORK,
  RESET_PAYLOADS, REVOKE_CREDENTIALS, REVOKE_OLD_GRANTS, type AuthorityReview,
} from "./authority-upgrade-acts";
import { CREDENTIAL_KINDS, OLD_GRANT_TABLES, REVISED_GRANT_TABLES } from "./authority-reset";
import { exact, plain } from "./fixtures/exact-rows";

// Every test here needs target 52; the switch is restored after each one.
const TARGET = 52;
const roots: string[] = [];
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "authority-acts-")); roots.push(root); return root; };

/** Historical time of every fixture write that takes a clock. */
const PAST = "2025-03-01T10:00:00.000Z";
const EARLIER = "2025-02-01T09:00:00.000Z";
const RECEIPT = "00000000-0000-4000-8000-000000000000";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const witnessFile = (paths: AppPaths) => join(securityFenceRoot(canonical(paths)), "witness.json");
const planFile = (paths: AppPaths) => upgradePlanPath(canonical(paths));
const read = <T,>(paths: AppPaths, operation: (database: Database.Database) => T) => {
  const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
  try { return operation(database); } finally { database.close(); }
};
/** The database and WAL bytes, the witness and the plan file: what a refusal must leave unchanged. */
const files = (paths: AppPaths) => {
  const wal = `${paths.databasePath}-wal`;
  return { database: sha(readFileSync(paths.databasePath)), wal: !existsSync(wal) || lstatSync(wal).size === 0 ? "empty" : sha(readFileSync(wal)),
    witness: existsSync(witnessFile(paths)) ? readFileSync(witnessFile(paths), "utf8") : "missing", plan: existsSync(planFile(paths)) ? readFileSync(planFile(paths), "utf8") : "missing" };
};
/** A raw write outside any owner, then a confirmed witness for the result: the fence trusts the database again. */
const tamper = (paths: AppPaths, operation: (database: Database.Database) => void) => {
  const database = unmanagedFixtureDatabase(paths.databasePath);
  try { operation(database); SecurityFence.attach(canonical(paths), database, true); } finally { database.close(); }
};
/** Rows the genuine schema refuses by CHECK, written with enforcement off. */
const unchecked = (database: Database.Database, sql: string) => { database.pragma("ignore_check_constraints = ON"); try { database.exec(sql); } finally { database.pragma("ignore_check_constraints = OFF"); } };
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
/** `auth fence resume` at 52 of a database whose witness is removed first when it is still trusted. */
const resume = (paths: AppPaths) => {
  if (maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).trusted) rmSync(witnessFile(paths));
  return maintainSqliteSecurityFence(paths, { action: "resume", expect: maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight, mode: "token" }, HANDOFF, TARGET);
};
const inspect = (paths: AppPaths, decisions?: unknown) => inspectSqliteUpgrade(paths, TARGET, decisions);
const review = (inspection: ReturnType<typeof inspect>) => inspection.review!.authority as AuthorityReview;

async function stepBackup(source: UpgradeBackupSource, destination: string, schemaVersion: number) {
  mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "attachments"), { mode: 0o700 });
  const file = join(destination, "state.sqlite3");
  closeSync(openSync(file, "wx", 0o600)); await source.backup(file); chmodSync(file, 0o600);
  const snapshot = new Database(file, { fileMustExist: true });
  try { snapshot.pragma("journal_mode = DELETE"); } finally { snapshot.close(); }
  const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(), database: { file: "state.sqlite3", ...hashFile(file), schemaVersion }, attachments: [] };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root: destination, manifest };
}
const backups = (paths: AppPaths, calls: string[] = []): UpgradeBackup => async (source, context) => {
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  calls.push(destination);
  if (context.schemaVersion <= SUPPORTED_SCHEMA_VERSION) {
    return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
  }
  return stepBackup(source, destination, context.schemaVersion);
};
const apply = (paths: AppPaths, expect: string, backup: UpgradeBackup = backups(paths)) => applySqliteUpgrade(paths, { expect }, backup, TARGET);
async function failure(operation: () => Promise<unknown> | unknown) {
  try { await operation(); } catch (error) {
    const { name, code, nextStep, committed, state, details } = error as { name: string; code: string; nextStep: string; committed: boolean; state?: string; details?: { findings: Array<{ table: string; id: string; problem: string }>; count: number; truncated: boolean } };
    return { name, code, nextStep, committed, state, details };
  }
  throw new Error("expected a refusal");
}

// ---------------------------------------------------------------------------
// The schema-49 fixture

const run = (id: string, phase: string, queuedAt: string, actor = "local-cli", project = "registration-a") => `INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,queued_at)
  VALUES('${id}','${project}','/code/project','head','main',0,'node:test','test','node','${actor}','${phase}',${phase === "queued" ? 1 : "NULL"},'pnpm','["test"]','/code/project','${queuedAt}');`;
/** 51 finished runs of one registration: with the queued and running runs interrupted, recovery trims the oldest 3. */
const HISTORY = Array.from({ length: 51 }, (_, index) => `history-${String(index).padStart(2, "0")}`);
const RECENT = () => new Date(Date.now() - 60_000).toISOString();
/** Material of the authentication provider, which the upgrade keeps and the quarantine clears. */
const PROVIDER = (owner: string) => `INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES('subject','Owner','owner@fixture.invalid',0,'now','now',1);
  INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,accessToken,createdAt,updatedAt) VALUES('account','subject','credential','subject','password-hash','access','now','now');
  INSERT INTO authentication_provider_subjects(provider_id,subject,principal_id,status,linked_at,revoked_at) VALUES('better-auth','subject','${owner}','active','${PAST}',NULL);
  INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,1,1,'${PAST}');
  INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId,verified) VALUES('factor','ciphertext','codes','subject',1);
  INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session','2030-01-01T00:00:00.000Z','token-session','now','now','subject');
  INSERT INTO authentication_ba_verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('verification','owner@fixture.invalid','value','2030-01-01T00:00:00.000Z','now','now');`;

interface Ids {
  owner: string; agent: string; agentB: string; worker: string; workerPrincipal: string; human: string;
  registrationA: string; registrationB: string; knowledge: string; remote: string;
  activeAgentToken: string; revokedAgentToken: string; scopedToken: string; workerToken: string; ownerSession: string;
}
/**
 * A schema-49 installation with authority of every old kind, built through
 * the product's write paths (owner session, agents and tokens, a worker and
 * its token, a human account; Knowledge grants and role bindings; runtime
 * delegations, a scoped credential and a membership; remote principal and
 * worker grants; reservations; remote requests), some already revoked or
 * released, all with historical times. Raw rows only where no product path
 * writes them: remote attempts in arbitrary phases, test runs with their
 * requesters, and the authentication provider's tables.
 */
function authorityWorld(options: { owner?: boolean } = {}): { paths: AppPaths; ids: Ids } {
  const paths = resolveAppPaths(join(temporary(), "data"));
  const store = new SqliteStateStore(paths.databasePath);
  const ids = {} as Ids;
  try {
    const identity = new IdentityService(store, () => PAST, undefined, undefined, { isCurrentInstallationActor: () => true }, store);
    const registrationA = store.addProject({ name: "alpha", repositoryPath: "/code/alpha", port: 4801, executable: "node", args: [] }).id;
    const registrationB = store.addProject({ name: "beta", repositoryPath: "/code/beta", port: 4802, executable: "node", args: [] }).id;
    Object.assign(ids, { registrationA, registrationB });
    if (options.owner === false) return { paths, ids };
    const bootstrapped = identity.bootstrapOwnerSession();
    const owner: AuthenticatedPrincipal = identity.authenticateBearer(bootstrapped.token);
    const agent = identity.createAgent(owner).id, agentB = identity.createAgent(owner).id;
    const activeAgentToken = identity.issueAgentToken({ principalId: agent, label: "active" }, owner).credential.id;
    const revokedAgentToken = identity.issueAgentToken({ principalId: agent, label: "revoked" }, owner).credential.id;
    identity.revokeCredential(revokedAgentToken, owner);
    const workerPrincipal = identity.createWorker(owner).id;
    const workerToken = identity.issueWorkerToken({ principalId: workerPrincipal, label: "worker" }, owner).credential.id;
    store.saveRemoteWorker({ id: "worker-a", principalId: workerPrincipal, name: "Worker A", status: "active", lastContactAt: null }, "fixture");
    store.humanAccounts().createHumanPrincipal({ id: "human-a", kind: "human", status: "active" }, "fixture");
    // Knowledge: grants of the owner and both agents (one revoked), role bindings (one revoked).
    const knowledge = identity.createKnowledgeProject({ name: "Knowledge" }, owner).id;
    for (const principalId of [bootstrapped.principalId, agent, agentB]) identity.setKnowledgeGrant({ principalId, projectId: knowledge, permissions: ["knowledge:read", "knowledge:write"] }, owner);
    identity.setKnowledgeRole({ principalId: bootstrapped.principalId, projectId: knowledge, role: "manager", expectedRevision: 0 }, owner);
    identity.setKnowledgeRole({ principalId: agentB, projectId: knowledge, role: "reader", expectedRevision: 0 }, owner);
    identity.revokeKnowledgeRole({ principalId: agentB, projectId: knowledge, expectedRevision: 1 }, owner);
    identity.revokeKnowledgeGrant(agentB, knowledge, owner);
    // Runtime: delegations (one revoked), a scoped credential naming registration A, a human membership.
    identity.setRuntimeDelegation({ principalId: agent, projectId: registrationA, actions: ["projects:read", "claims:manage"], expectedRevision: 0 }, owner);
    identity.setRuntimeDelegation({ principalId: agent, projectId: registrationB, actions: ["projects:read"], expectedRevision: 0 }, owner);
    identity.revokeRuntimeDelegation({ principalId: agent, projectId: registrationB, expectedRevision: 1 }, owner);
    const scopedToken = identity.issueRuntimeCredential({ principalId: agent, label: "scoped", projects: [{ projectId: registrationA, actions: ["projects:read"] }] }, owner).credential.id;
    store.runtimeMemberships().saveRuntimeMembership({ principalId: "human-a", scope: { kind: "runtime-project", id: registrationA }, role: "reader", permissions: ["projects:read"], expectedRevision: 0 }, "fixture", PAST);
    store.runtimeMemberships().saveRuntimeMembership({ principalId: "human-a", scope: { kind: "runtime-project", id: registrationB }, role: "reader", permissions: ["projects:read"], expectedRevision: 0 }, "fixture", EARLIER);
    store.runtimeMemberships().saveRuntimeMembership({ principalId: "human-a", scope: { kind: "runtime-project", id: registrationB }, expectedRevision: 1 }, "fixture", PAST);
    // Remote: an identity, principal grants (one revoked), worker bindings (one revoked), requests in every phase.
    store.saveRemoteProjectIdentity({ id: "remote-a", name: "Remote A", sourceRemote: "origin", status: "active" }, "local-cli");
    store.saveRemotePrincipalProjectGrant({ principalId: agent, projectId: "remote-a", permissions: ["submit", "read"], revokedAt: null }, "fixture");
    store.saveRemotePrincipalProjectGrant({ principalId: agentB, projectId: "remote-a", permissions: ["read"], revokedAt: EARLIER }, "fixture");
    store.saveRemoteWorkerProjectGrant({ workerId: "worker-a", projectId: "remote-a", localProjectId: registrationA, presetIds: ["node:test"], revokedAt: null }, "fixture");
    for (const phase of ["pending", "assigned", "completed", "cancelled"] as const) {
      store.createOrReplayRemoteVerificationRequest({ id: `request-${phase}`, projectId: "remote-a", workerId: "worker-a", requestedBy: agent, commitSha: "c".repeat(40),
        presetId: "node:test", idempotencyKey: `key-${phase}`, phase, createdAt: PAST, updatedAt: PAST });
    }
    // Reservations: an active claim on A, a released one on B.
    store.acquireReservation({ projectId: registrationA, worktreePath: "/code/alpha", kind: "human", owner: "fixture" });
    store.acquireReservation({ projectId: registrationB, worktreePath: "/code/beta", kind: "human", owner: "fixture" });
    store.releaseReservation(registrationB, "fixture");
    Object.assign(ids, { owner: bootstrapped.principalId, agent, agentB, worker: "worker-a", workerPrincipal, human: "human-a", knowledge, remote: "remote-a",
      activeAgentToken, revokedAgentToken, scopedToken, workerToken, ownerSession: bootstrapped.credential.id });
  } finally { store.close(); }
  tamper(paths, database => {
    const attempts = ["assigned", "preparing", "running", "succeeded", "failed", "cancel_requested", "cancelled", "uncertain"];
    for (const [index, phase] of attempts.entries()) {
      database.prepare(`INSERT INTO remote_verification_attempts(id,request_id,worker_id,sequence,phase,version,accepted_at,last_reported_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(`attempt-${phase}`, "request-assigned", "worker-a", index + 1, phase, 2, PAST, PAST);
    }
    database.exec([...HISTORY.map((id, index) => run(id, "passed", `2025-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, index === 0 || index === 50 ? "agent:mcp:fixture" : "local-cli", ids.registrationA)),
      run("queued-run", "queued", RECENT(), "local-cli", ids.registrationA), run("running-run", "running", RECENT(), "local-cli", ids.registrationA)].join("\n"));
    database.prepare(`INSERT INTO test_run_requesters(run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash) VALUES(?,?,?,?,?,NULL,NULL),(?,?,?,?,?,NULL,NULL)`)
      .run("history-00", ids.agent, ids.activeAgentToken, ids.registrationA, "agent:mcp:fixture", "history-50", ids.agent, ids.activeAgentToken, ids.registrationA, "agent:mcp:fixture");
    // A revoked credential without a revocation time: the reset sets one, as the quarantine always did.
    database.prepare("UPDATE principal_credentials SET status='revoked',revoked_at=NULL WHERE id=?").run(ids.workerToken);
    database.exec(PROVIDER(ids.owner));
  });
  return { paths, ids };
}
/** A copy of a database file (and its WAL) for a twin run. */
function copy(paths: AppPaths): string {
  const target = join(temporary(), "twin.sqlite3");
  copyFileSync(paths.databasePath, target);
  if (existsSync(`${paths.databasePath}-wal`)) copyFileSync(`${paths.databasePath}-wal`, `${target}-wal`);
  return target;
}
const at = (target: number) => (database: Database.Database) => { inspectSchema(database, target); };
const upgradeTime = (database: Database.Database) => database.prepare("SELECT created_at FROM controller_audit_events WHERE event_type='authentication.upgrade_applied' ORDER BY id DESC LIMIT 1").pluck().get() as string;
const grantsOf = (database: Database.Database) => database.prepare("SELECT account_id,role,scope_kind,project_id,granted_at FROM account_grants ORDER BY rowid").all();

// ---------------------------------------------------------------------------

describe("authority acts: the domain", () => {
  it("follows the mapping domain from 52 on, takes no decision and has four act kinds with fixed reset payloads", () => {
    expect(AUTHORITY_ACT_DOMAIN).toMatchObject({ name: "authority", minimumTarget: 52, decisionKeys: [] });
    expect(AUTHORITY_ACT_DOMAIN.kinds.map(kind => kind.kind)).toEqual([REVOKE_OLD_GRANTS, REVOKE_CREDENTIALS, RELEASE_RUNNING_WORK, GRANT_ADMIN]);
    expect(normaliseAuthorityDecisions({})).toEqual({});
    expect(() => normaliseAuthorityDecisions({ grant: "x" })).toThrowError(expect.objectContaining({ code: "upgrade_decisions_invalid" }));
    // Through the plan's normalisation: mapping keys go to the mapping domain, any other key is refused.
    expect(normaliseUpgradeDecisions({}, TARGET)).toEqual({ mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } }, authority: {} });
    expect(() => normaliseUpgradeDecisions({ admin: "someone" }, TARGET)).toThrowError(expect.objectContaining({ code: "upgrade_decisions_invalid" }));
    expect(normaliseUpgradeDecisions({}, 51)).toEqual({ mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } });
    expect(OLD_GRANT_TABLES).toEqual(["knowledge_project_grants", "knowledge_role_bindings", "runtime_delegations", "runtime_human_memberships", "remote_principal_project_grants", "remote_worker_project_grants"]);
    expect(CREDENTIAL_KINDS).toEqual(["agent_token", "owner_session", "worker_token"]);
    for (const [kind, payload] of Object.entries(RESET_PAYLOADS)) {
      const entry = AUTHORITY_ACT_DOMAIN.kinds.find(candidate => candidate.kind === kind)!;
      expect(entry.payload.safeParse(payload).success, kind).toBe(true);
      expect(entry.payload.safeParse({ ...payload, extra: 1 }).success, kind).toBe(false);
    }
    expect(AUTHORITY_ACT_DOMAIN.kinds[0].payload.safeParse({ tables: [...OLD_GRANT_TABLES].reverse() }).success).toBe(false);
    expect(AUTHORITY_ACT_DOMAIN.kinds[1].payload.safeParse({ kinds: ["agent_token"] }).success).toBe(false);
  });

  it("enumerates every credential kind the schema allows and revokes all of them", () => {
    const database = new Database(":memory:");
    try {
      initializeSchema(database);
      const sql = database.prepare("SELECT sql FROM sqlite_master WHERE name='principal_credentials'").pluck().get() as string;
      const kinds = /kind TEXT NOT NULL CHECK\(kind IN \(([^)]*)\)\)/.exec(sql)![1].split(",").map(entry => entry.trim().replaceAll("'", "")).sort();
      expect(kinds).toEqual([...CREDENTIAL_KINDS]);
    } finally { database.close(); }
  });
});

describe("authority acts: apply at target 52 from schema 49", () => {
  /** What an apply from 49 may change; every other table, row and value is byte-identical. */
  const CHANGED: Readonly<Record<string, readonly string[]>> = {
    knowledge_project_grants: ["revoked_at"], knowledge_role_bindings: ["revoked_at", "revision", "updated_at"], runtime_delegations: ["revoked_at", "revision", "updated_at"],
    runtime_human_memberships: ["revoked_at", "revision", "updated_at"], remote_principal_project_grants: ["revoked_at"], remote_worker_project_grants: ["revoked_at"],
    principal_credentials: ["status", "revoked_at"], reservations: ["released_at"], remote_verification_requests: ["phase", "updated_at"],
    remote_verification_attempts: ["phase", "version", "last_reported_at"], security_checkpoint: ["epoch"],
  };
  const MAPPED = { projects: ["parent_project_id", "incarnation", "mapping_version"], remote_project_identities: ["parent_project_id", "incarnation", "mapping_version"] } as Record<string, string[]>;
  const APPEND_ONLY = ["knowledge_projects", "controller_audit_events", "schema_migrations"];
  const CREATED = ["account_grants", "project_mapping_clock", "project_mapping_journal", "upgrade_marker"];
  /** Checked on their own below: the runs the recovery interrupts and trims, their summaries and requesters. */
  const RUNS = ["test_runs", "test_run_summaries", "test_summary_coverage", "test_run_requesters", "human_test_run_requesters", "sqlite_sequence"];

  it("revokes, releases and interrupts exactly as planned, grants admin to the owner, and keeps everything else byte-identical", async () => {
    const { paths, ids } = authorityWorld();
    const before = read(paths, exact);
    const inspection = inspect(paths);
    expect(inspection.plan!.acts.map(act => act.kind).slice(-4)).toEqual([REVOKE_OLD_GRANTS, REVOKE_CREDENTIALS, RELEASE_RUNNING_WORK, GRANT_ADMIN]);
    expect(inspection.plan!.acts.at(-1)).toEqual({ kind: GRANT_ADMIN, payload: { accountId: ids.owner } });
    // Every mapping act precedes every authority act.
    const authority = new Set(AUTHORITY_ACT_DOMAIN.kinds.map(kind => kind.kind));
    const first = inspection.plan!.acts.findIndex(act => authority.has(act.kind));
    expect(inspection.plan!.acts.slice(first).every(act => authority.has(act.kind))).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(inspection.plan!.format).toBe(2);
    expect(inspection.plan!.steps.map(step => step.version)).toEqual([50, 51, 52]);
    const planned = review(inspection);
    await apply(paths, inspection.planHash!);
    const after = read(paths, exact);
    const time = read(paths, upgradeTime);

    expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual(CREATED);
    for (const [table, rows] of Object.entries(before)) {
      if (RUNS.includes(table)) continue;
      const later = after[table], allowed = CHANGED[table] ?? [];
      for (const [rowid, row] of Object.entries(rows)) {
        expect(later[rowid], `${table} ${rowid}`).toBeDefined();
        expect(Object.fromEntries(Object.entries(later[rowid]).filter(([column]) => column in row && !allowed.includes(column))), `${table} ${rowid}`)
          .toEqual(Object.fromEntries(Object.entries(row).filter(([column]) => !allowed.includes(column))));
        expect(Object.keys(later[rowid]).filter(column => !(column in row)), table).toEqual(MAPPED[table] ?? []);
      }
      if (!APPEND_ONLY.includes(table)) expect(Object.keys(later).filter(rowid => !(rowid in rows)), table).toEqual([]);
    }
    // The six tables: every row revoked; an earlier revocation time is kept; revisions advance where the quarantine advances them.
    for (const table of OLD_GRANT_TABLES) {
      expect(Object.keys(before[table]).length, table).toBeGreaterThan(0);
      for (const [rowid, row] of Object.entries(before[table])) {
        const later = after[table][rowid];
        expect(plain(later.revoked_at), `${table} ${rowid}`).toBe(row.revoked_at === "null" ? time : plain(row.revoked_at));
        if (REVISED_GRANT_TABLES.includes(table)) {
          expect(plain(later.revision)).toBe((plain(row.revision) as number) + 1);
          expect(plain(later.updated_at)).toBe(time);
        }
      }
    }
    expect(Object.values(before.knowledge_project_grants).some(row => row.revoked_at !== "null")).toBe(true);
    // Credential scopes are byte-identical (inert rows); their credentials are revoked.
    expect(after.runtime_credential_scopes).toEqual(before.runtime_credential_scopes);
    expect(Object.keys(before.runtime_credential_scopes)).toHaveLength(1);
    // Every credential of the three kinds revoked, an earlier revocation time kept.
    for (const [rowid, row] of Object.entries(before.principal_credentials)) {
      expect(plain(after.principal_credentials[rowid].status)).toBe("revoked");
      expect(plain(after.principal_credentials[rowid].revoked_at)).toBe(row.revoked_at === "null" ? time : plain(row.revoked_at));
    }
    expect(new Set(Object.values(before.principal_credentials).map(row => plain(row.kind)))).toEqual(new Set(CREDENTIAL_KINDS));
    read(paths, database => {
      // The installation token, the mode and every table of the authentication provider are byte-identical (the comparison above), and present.
      expect(JSON.parse(database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get() as string)).toHaveProperty("mode");
      expect(database.prepare("SELECT password FROM authentication_ba_account").pluck().get()).toBe("password-hash");
      expect(database.prepare("SELECT count(*) FROM authentication_ba_session").pluck().get()).toBe(1);
      // Reservations released; remote work cancelled as the quarantine cancels it.
      expect(database.prepare("SELECT count(*) FROM reservations WHERE released_at IS NULL").pluck().get()).toBe(0);
      expect(database.prepare("SELECT id,phase FROM remote_verification_requests ORDER BY id").all()).toEqual([
        { id: "request-assigned", phase: "cancelled" }, { id: "request-cancelled", phase: "cancelled" }, { id: "request-completed", phase: "completed" }, { id: "request-pending", phase: "cancelled" }]);
      expect(database.prepare("SELECT id,phase,version FROM remote_verification_attempts ORDER BY sequence").all()).toEqual([
        { id: "attempt-assigned", phase: "cancel_requested", version: 3 }, { id: "attempt-preparing", phase: "cancel_requested", version: 3 }, { id: "attempt-running", phase: "cancel_requested", version: 3 },
        { id: "attempt-succeeded", phase: "succeeded", version: 2 }, { id: "attempt-failed", phase: "failed", version: 2 }, { id: "attempt-cancel_requested", phase: "cancel_requested", version: 2 },
        { id: "attempt-cancelled", phase: "cancelled", version: 2 }, { id: "attempt-uncertain", phase: "uncertain", version: 2 }]);
      // Queued and running runs interrupted with terminal summaries; the oldest three finished runs trimmed with their requester.
      expect(database.prepare("SELECT id,phase,queue_position FROM test_runs WHERE id IN ('queued-run','running-run') ORDER BY id").all())
        .toEqual([{ id: "queued-run", phase: "interrupted", queue_position: null }, { id: "running-run", phase: "interrupted", queue_position: null }]);
      expect(database.prepare("SELECT run_id,terminal FROM test_run_summaries WHERE run_id IN ('queued-run','running-run') ORDER BY run_id").all())
        .toEqual([{ run_id: "queued-run", terminal: 1 }, { run_id: "running-run", terminal: 1 }]);
      expect(database.prepare("SELECT id FROM test_runs WHERE id LIKE 'history-%' ORDER BY id").pluck().all()).toEqual(HISTORY.slice(3));
      expect(database.prepare("SELECT run_id FROM test_run_requesters ORDER BY run_id").pluck().all()).toEqual(["history-50"]);
      // Exactly one new grant: admin on the installation, for the owner, with the run's time.
      expect(grantsOf(database)).toEqual([{ account_id: ids.owner, role: "admin", scope_kind: "installation", project_id: null, granted_at: time }]);
      expect(database.prepare("SELECT state,plan_hash FROM upgrade_marker").get()).toEqual({ state: "complete", plan_hash: inspection.planHash });
      expect(inspectSchema(database, TARGET).version).toBe(52);
      // The mapping acts' effects as before: every registration and identity parented.
      for (const table of ["projects", "remote_project_identities"]) expect(database.prepare(`SELECT count(*) FROM ${table} WHERE parent_project_id IS NULL`).pluck().get()).toBe(0);
    });
    // Kept runs and their requester are byte-identical; only the two interrupted runs changed and the three oldest are gone.
    const runIds = (rows: Record<string, Record<string, string>>) => Object.values(rows).map(row => plain(row.id) as string).sort();
    expect(runIds(after.test_runs)).toEqual(runIds(before.test_runs).filter(id => !HISTORY.slice(0, 3).includes(id)));
    for (const [rowid, row] of Object.entries(before.test_runs)) {
      const id = plain(row.id) as string;
      if (["queued-run", "running-run"].includes(id) || HISTORY.slice(0, 3).includes(id)) continue;
      expect(after.test_runs[rowid], id).toEqual(row);
    }
    expect(Object.values(after.test_run_requesters)).toEqual(Object.values(before.test_run_requesters).filter(row => plain(row.run_id) === "history-50"));
    // The review counted what happened.
    expect(planned.testRuns).toEqual({ queued: 1, running: 1, unfinishedSummaries: 0, interrupts: 2, trimmed: 3 });
    expect(planned.reservations).toEqual({ active: 1, released: 1, releases: 1 });
  });

  it("states the review in counts, IDs, kinds and statuses, and the operator's lines say what the upgrade does and keeps", () => {
    const { paths, ids } = authorityWorld();
    const inspection = inspect(paths);
    const authority = review(inspection);
    expect(authority.grantTables).toEqual([
      { table: "knowledge_project_grants", rows: 3, alreadyRevoked: 1, revokes: 2, revisionAdvances: false },
      { table: "knowledge_role_bindings", rows: 2, alreadyRevoked: 1, revokes: 1, revisionAdvances: true },
      { table: "runtime_delegations", rows: 2, alreadyRevoked: 1, revokes: 1, revisionAdvances: true },
      { table: "runtime_human_memberships", rows: 2, alreadyRevoked: 1, revokes: 1, revisionAdvances: true },
      { table: "remote_principal_project_grants", rows: 2, alreadyRevoked: 1, revokes: 1, revisionAdvances: false },
      { table: "remote_worker_project_grants", rows: 1, alreadyRevoked: 0, revokes: 1, revisionAdvances: false },
    ]);
    expect(authority.credentialScopes).toEqual({ rows: 1, inert: 1, credentials: { before: { active: 1, revoked: 0, missing: 0 }, after: { active: 0, revoked: 1, missing: 0 } } });
    expect(authority.credentials).toEqual([
      { kind: "agent_token", active: 2, revoked: 1, revokedWithoutTime: 0, revokes: 2 },
      { kind: "owner_session", active: 1, revoked: 0, revokedWithoutTime: 0, revokes: 1 },
      { kind: "worker_token", active: 0, revoked: 1, revokedWithoutTime: 1, revokes: 0 },
    ]);
    expect(authority.remoteRequests).toEqual({ phases: { pending: 1, assigned: 1, completed: 1, cancelled: 1 }, cancels: 2 });
    expect(authority.remoteAttempts).toEqual({ phases: { assigned: 1, preparing: 1, running: 1, succeeded: 1, failed: 1, cancel_requested: 1, cancelled: 1, uncertain: 1 }, cancels: 3 });
    expect(authority.owners).toEqual([{ id: ids.owner, status: "active" }]);
    expect(authority.admin).toEqual({ decision: "grant", accountId: ids.owner });
    const lines = inspection.acts!.join("\n");
    for (const statement of ["This upgrade is one-way", "Every listed token stops working", "Rights must be granted again", "Running work is interrupted",
      "does not prove that a remote process stopped", AUTHORITY_KEPT, `Grant admin on the installation to owner account ${ids.owner}.`]) expect(lines).toContain(statement);
    // No token hash, token prefix, password or provider material reaches the plan file.
    const file = readFileSync(planFile(paths), "utf8");
    read(paths, database => {
      for (const value of database.prepare("SELECT verifier_hash FROM principal_credentials UNION ALL SELECT token_prefix FROM principal_credentials").pluck().all() as string[]) expect(file).not.toContain(value);
    });
    for (const secret of ["password-hash", "token-session", "ciphertext", "owner@fixture.invalid"]) expect(file).not.toContain(secret);
  });
});

describe("authority acts: the admin rule", () => {
  it.each([
    ["no owner", "no_owner", () => authorityWorld({ owner: false }).paths],
    ["one owner that is revoked", "owner_not_active", () => { const { paths } = authorityWorld(); tamper(paths, database => database.exec("UPDATE remote_principals SET status='revoked' WHERE kind='owner'")); return paths; }],
    ["several owners", "several_owners", () => { const { paths } = authorityWorld(); tamper(paths, database => database.exec("INSERT INTO remote_principals(id,kind,status) VALUES('owner-second','owner','active')")); return paths; }],
    ["several owners of which one is revoked", "several_owners", () => { const { paths } = authorityWorld(); tamper(paths, database => database.exec("INSERT INTO remote_principals(id,kind,status) VALUES('owner-second','owner','revoked')")); return paths; }],
  ] as const)("grants no admin with %s, states the reason and that the first admin is created later", async (_name, reason, build) => {
    const paths = build();
    const inspection = inspect(paths);
    expect(review(inspection).admin).toEqual({ decision: "none", reason });
    expect(inspection.plan!.acts.map(act => act.kind)).not.toContain(GRANT_ADMIN);
    expect(inspection.plan!.acts.slice(-3).map(act => act.kind)).toEqual([REVOKE_OLD_GRANTS, REVOKE_CREDENTIALS, RELEASE_RUNNING_WORK]);
    expect(inspection.acts!.join("\n")).toContain("No account will hold admin after the upgrade");
    expect(inspection.acts!.join("\n")).toContain("The first admin is created later by the local operator.");
    await apply(paths, inspection.planHash!);
    read(paths, database => expect(grantsOf(database)).toEqual([]));
  });

  it("grants admin to the single active owner only", async () => {
    const { paths, ids } = authorityWorld();
    const inspection = inspect(paths);
    expect(review(inspection).admin).toEqual({ decision: "grant", accountId: ids.owner });
    await apply(paths, inspection.planHash!);
    read(paths, database => expect(grantsOf(database)).toEqual([expect.objectContaining({ account_id: ids.owner, role: "admin", scope_kind: "installation", project_id: null })]));
  });

  it("re-checks the rule when the act executes", () => {
    const database = unmanagedFixtureDatabase();
    try {
      initializeSchema(database, true, at(TARGET), { target: TARGET });
      database.exec("INSERT INTO remote_principals(id,kind,status) VALUES('owner-a','owner','active')");
      const grant = AUTHORITY_ACT_DOMAIN.kinds.find(kind => kind.kind === GRANT_ADMIN)!;
      const context = { source: 49, target: TARGET, planHash: "0".repeat(64), receipt: RECEIPT, at: PAST };
      const attempt = (accountId: string) => database.transaction(() => grant.execute(database, { accountId }, context))();
      expect(() => attempt("someone-else")).toThrow(/Upgrade act grant_admin/);
      database.exec("INSERT INTO remote_principals(id,kind,status) VALUES('owner-b','owner','active')");
      expect(() => attempt("owner-a")).toThrow(/Upgrade act grant_admin/);
      database.exec("DELETE FROM remote_principals WHERE id='owner-b'; UPDATE remote_principals SET status='revoked' WHERE id='owner-a'");
      expect(() => attempt("owner-a")).toThrow(/Upgrade act grant_admin/);
      database.exec("UPDATE remote_principals SET status='active' WHERE id='owner-a'");
      attempt("owner-a");
      expect(() => attempt("owner-a")).toThrow(/Upgrade act grant_admin/);
      expect(grantsOf(database)).toEqual([{ account_id: "owner-a", role: "admin", scope_kind: "installation", project_id: null, granted_at: PAST }]);
    } finally { database.close(); }
  });
});

describe("authority acts: the same reset as the quarantine", () => {
  /** Tables both write, compared exactly; and the tables only the quarantine changes. */
  const SHARED = [...OLD_GRANT_TABLES, "runtime_credential_scopes", "principal_credentials", "reservations", "remote_verification_requests", "remote_verification_attempts",
    "test_runs", "test_run_summaries", "test_summary_coverage", "test_run_requesters", "human_test_run_requesters"];
  const QUARANTINE_ONLY = ["authentication_account_policies", "authentication_ba_account", "authentication_ba_session", "authentication_ba_two_factor", "authentication_ba_user",
    "authentication_ba_verification", "controller_audit_events", "controller_settings", "project_mapping_clock", "projects", "remote_project_identities", "sqlite_sequence", "upgrade_marker"];

  it("produces identical rows in every shared table on twin databases, and differs exactly where only the quarantine acts", () => {
    const { paths } = authorityWorld();
    const original = read(paths, exact);
    const upgraded = unmanagedFixtureDatabase(copy(paths)), quarantined = unmanagedFixtureDatabase(copy(paths));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date());
    try {
      const context = { source: 49, target: TARGET, planHash: "0".repeat(64), receipt: RECEIPT, at: new Date().toISOString() };
      initializeSchema(upgraded, false, at(TARGET), { target: TARGET, acts: current => {
        for (const kind of AUTHORITY_ACT_DOMAIN.kinds.filter(entry => entry.kind !== GRANT_ADMIN)) kind.execute(current, RESET_PAYLOADS[kind.kind as keyof typeof RESET_PAYLOADS], context);
      } });
      initializeSchema(quarantined, false, at(TARGET), { target: TARGET, acts: current => quarantineAuthority(current, RECEIPT, "token", TARGET) });
      const left = exact(upgraded), right = exact(quarantined);
      for (const table of SHARED) expect(left[table], table).toEqual(right[table]);
      // The checkpoint's epoch is random on every covered write.
      const differing = Object.keys(left).filter(table => table !== "security_checkpoint" && canonicalJson(left[table]) !== canonicalJson(right[table])).sort();
      expect(differing).toEqual(QUARANTINE_ONLY);
      // What only the quarantine does, explicitly; the upgrade's acts leave each as it was.
      const both = (sql: string) => [upgraded.prepare(sql).all(), quarantined.prepare(sql).all()];
      expect(both("SELECT password,accessToken FROM authentication_ba_account")).toEqual([[{ password: "password-hash", accessToken: "access" }], [{ password: null, accessToken: null }]]);
      for (const table of ["authentication_ba_session", "authentication_ba_two_factor", "authentication_ba_verification"]) expect(both(`SELECT count(*) AS n FROM ${table}`), table).toEqual([[{ n: 1 }], [{ n: 0 }]]);
      expect(both("SELECT twoFactorEnabled FROM authentication_ba_user")).toEqual([[{ twoFactorEnabled: 1 }], [{ twoFactorEnabled: 0 }]]);
      expect(both("SELECT generation,totp_selected FROM authentication_account_policies")).toEqual([[{ generation: 1, totp_selected: 1 }], [{ generation: 2, totp_selected: 0 }]]);
      const settings = both("SELECT value_json FROM controller_settings WHERE key='authentication'").map(rows => JSON.parse((rows[0] as { value_json: string }).value_json));
      expect(settings[0].token).not.toBeNull();
      expect(settings[1]).toMatchObject({ mode: "token", token: null, generation: settings[0].generation + 1 });
      expect(both("SELECT count(*) AS n FROM controller_audit_events WHERE event_type='authentication.security_quarantined'")).toEqual([[{ n: 0 }], [{ n: 1 }]]);
      expect(both("SELECT count(*) AS n FROM projects WHERE mapping_version<>0")).toEqual([[{ n: 0 }], [{ n: 2 }]]);
      // The upgrade's acts left the provider tables, settings and mapping exactly as the source had them.
      for (const table of QUARANTINE_ONLY.filter(name => name in original && !["controller_audit_events", "sqlite_sequence", "projects", "remote_project_identities"].includes(name))) {
        expect(left[table], table).toEqual(original[table]);
      }
    } finally { upgraded.close(); quarantined.close(); }
  });
});

describe("authority acts: the quarantine after the extraction", () => {
  /**
   * `quarantineAuthority` as it was before the reset statements were extracted
   * (integration branch at 27e79d1e), copied as a literal: the refactored
   * quarantine must have exactly its effects.
   */
  function quarantineBefore(database: Database.Database, receipt: string, mode: "token" | "open" | "better-auth", target?: number): void {
    const version = schemaTarget(target);
    const now = new Date().toISOString();
    const old=JSON.parse((database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").get() as {value_json:string}).value_json);
    if(!Number.isSafeInteger(old.generation) || old.generation>=Number.MAX_SAFE_INTEGER
      || database.prepare("SELECT 1 FROM authentication_account_policies WHERE generation>=9007199254740991 OR policy_revision>=9007199254740991 LIMIT 1").get()) throw new SecurityFenceError("security_fence_recovery_required");
    const mapping = version >= 51 ? planMappingQuarantine(database) : undefined;
    if (mapping === null) throw new SecurityFenceError("security_fence_recovery_required");
    database.exec(`
    UPDATE principal_credentials SET status='revoked', revoked_at=coalesce(revoked_at,'${now}');
    UPDATE knowledge_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
    UPDATE knowledge_role_bindings SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
    UPDATE runtime_delegations SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
    UPDATE runtime_human_memberships SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
    UPDATE remote_principal_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
    UPDATE remote_worker_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
    UPDATE authentication_ba_account SET password=NULL,accessToken=NULL,refreshToken=NULL,idToken=NULL;
    DELETE FROM authentication_session_issuance;
    DELETE FROM authentication_session_evidence;
    DELETE FROM authentication_ba_session;
    DELETE FROM authentication_ba_verification;
    DELETE FROM authentication_passkey_staged;
    DELETE FROM authentication_passkey_trust;
    DELETE FROM authentication_ba_passkey;
    DELETE FROM authentication_ba_two_factor;
    UPDATE authentication_ba_user SET twoFactorEnabled=0;
    UPDATE authentication_account_policies SET generation=generation+1,policy_revision=policy_revision+1,totp_selected=0,passkey_selected=0,updated_at='${now}';
    UPDATE authentication_factor_contexts SET used=1;
    UPDATE authentication_factor_receipts SET state='failed' WHERE state='charged';
    UPDATE reservations SET released_at=coalesce(released_at,'${now}');
    UPDATE remote_verification_requests SET phase='cancelled',updated_at='${now}' WHERE phase IN ('pending','assigned');
    UPDATE remote_verification_attempts SET phase='cancel_requested',version=version+1,last_reported_at='${now}' WHERE phase IN ('assigned','preparing','running');
  `);
    if (version >= 50) database.prepare("UPDATE upgrade_marker SET state='pending',changed_at=?,plan_hash=NULL WHERE singleton=1").run(now);
    if (mapping) applyMappingQuarantine(database, mapping);
    database.prepare("UPDATE controller_settings SET value_json=?,updated_at=? WHERE key='authentication'")
      .run(JSON.stringify({mode,generation:old.generation+1,token:null}),now);
    new TestRunQueries(database).markInterruptedTestRuns();
    database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('authentication.security_quarantined','local-cli',?,?)")
      .run(JSON.stringify({receipt,mode}),now);
  }

  it.each([[undefined], [50], [51]] as const)("has exactly the pre-extraction effects at target %s, compared by storage class and bytes", target => {
    const { paths } = authorityWorld();
    const left = unmanagedFixtureDatabase(copy(paths)), right = unmanagedFixtureDatabase(copy(paths));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date());
    try {
      const version = target ?? 49;
      initializeSchema(left, false, at(version), { target, acts: current => quarantineBefore(current, RECEIPT, "token", target) });
      initializeSchema(right, false, at(version), { target, acts: current => quarantineAuthority(current, RECEIPT, "token", target) });
      const a = exact(left), b = exact(right);
      delete a.security_checkpoint; delete b.security_checkpoint;
      // The step-50 marker's initial row takes SQLite's clock, which the fake timer does not move; the quarantine rewrites it with its own time.
      expect(Object.keys(a)).toEqual(Object.keys(b));
      for (const table of Object.keys(a)) expect(a[table], table).toEqual(b[table]);
      expect(left.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(right.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all());
    } finally { left.close(); right.close(); }
  });

  it("runs the reset statements in the quarantine's order, around its own", () => {
    const { paths } = authorityWorld();
    const database = unmanagedFixtureDatabase(copy(paths)), statements: string[] = [];
    try {
      const exec = database.exec.bind(database);
      let recording = false;
      Object.assign(database, { exec: (source: string) => { if (recording) statements.push(source); return exec(source); } });
      initializeSchema(database, false, undefined, { acts: current => { recording = true; try { quarantineAuthority(current, RECEIPT, "token"); } finally { recording = false; } } });
      const order = statements.join("\n").split("\n").map(line => line.trim()).filter(line => /^(UPDATE|DELETE)/.test(line)).map(line => line.split(" ")[0] + " " + line.split(" ")[line.startsWith("DELETE") ? 2 : 1]);
      expect(order).toEqual([
        "UPDATE principal_credentials", ...OLD_GRANT_TABLES.map(table => `UPDATE ${table}`),
        "UPDATE authentication_ba_account", "DELETE authentication_session_issuance", "DELETE authentication_session_evidence", "DELETE authentication_ba_session",
        "DELETE authentication_ba_verification", "DELETE authentication_passkey_staged", "DELETE authentication_passkey_trust", "DELETE authentication_ba_passkey",
        "DELETE authentication_ba_two_factor", "UPDATE authentication_ba_user", "UPDATE authentication_account_policies", "UPDATE authentication_factor_contexts",
        "UPDATE authentication_factor_receipts", "UPDATE reservations", "UPDATE remote_verification_requests", "UPDATE remote_verification_attempts",
      ]);
    } finally { database.close(); }
  });
});

describe("authority acts: whole-plan validation", () => {
  const writePlan = (paths: AppPaths, payload: unknown) => {
    const hash = sha(canonicalJson(payload));
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    return hash;
  };
  const indexOf = (plan: UpgradePlan, kind: string) => plan.acts.findIndex(act => act.kind === kind);
  type Mutation = (plan: UpgradePlan, ids: Ids) => UpgradePlan;
  const MUTATIONS: Array<[string, Mutation, (paths: AppPaths) => void]> = [
    ["a plan without the grant revocation", plan => { plan.acts.splice(indexOf(plan, REVOKE_OLD_GRANTS), 1); return plan; }, () => undefined],
    ["a plan without the credential revocation", plan => { plan.acts.splice(indexOf(plan, REVOKE_CREDENTIALS), 1); return plan; }, () => undefined],
    ["a plan without the release of running work", plan => { plan.acts.splice(indexOf(plan, RELEASE_RUNNING_WORK), 1); return plan; }, () => undefined],
    ["an admin grant for another account (a human)", (plan, ids) => { plan.acts[indexOf(plan, GRANT_ADMIN)] = { kind: GRANT_ADMIN, payload: { accountId: ids.human } }; return plan; }, () => undefined],
    ["an admin grant for a non-owner (an agent), review forged to match", (plan, ids) => {
      plan.acts[indexOf(plan, GRANT_ADMIN)] = { kind: GRANT_ADMIN, payload: { accountId: ids.agent } };
      (plan.review.authority as AuthorityReview).admin = { decision: "grant", accountId: ids.agent };
      return plan;
    }, () => undefined],
    ["an admin grant when there are several owners", (plan, ids) => {
      plan.acts.push({ kind: GRANT_ADMIN, payload: { accountId: ids.owner } });
      (plan.review.authority as AuthorityReview).admin = { decision: "grant", accountId: ids.owner };
      return plan;
    }, paths => tamper(paths, database => database.exec("INSERT INTO remote_principals(id,kind,status) VALUES('owner-second','owner','active')"))],
    ["authority acts out of their order", plan => { const a = indexOf(plan, REVOKE_OLD_GRANTS), b = indexOf(plan, REVOKE_CREDENTIALS); [plan.acts[a], plan.acts[b]] = [plan.acts[b], plan.acts[a]]; return plan; }, () => undefined],
    ["the admin grant before the reset acts", plan => { const grant = plan.acts.splice(indexOf(plan, GRANT_ADMIN), 1)[0]; plan.acts.splice(indexOf(plan, REVOKE_OLD_GRANTS), 0, grant); return plan; }, () => undefined],
    ["a review whose revocation counts do not match the database", plan => { (plan.review.authority as AuthorityReview).grantTables[0].revokes += 1; return plan; }, () => undefined],
    ["a review whose trimming count does not match the database", plan => { (plan.review.authority as AuthorityReview).testRuns.trimmed = 0; return plan; }, () => undefined],
  ];

  it.each(MUTATIONS)("refuses %s before the backup with nothing changed, and again inside the transaction", async (_name, mutate, prepare) => {
    const { paths, ids } = authorityWorld();
    prepare(paths);
    const genuine = inspect(paths).plan!;
    const payload = mutate(JSON.parse(JSON.stringify(genuine)) as UpgradePlan, ids);
    const hash = writePlan(paths, payload);
    const before = files(paths), calls: string[] = [];
    expect(await failure(() => apply(paths, hash, backups(paths, calls)))).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false });
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
    const database = unmanagedFixtureDatabase(copy(paths));
    try {
      expect(() => initializeSchema(database, false, at(TARGET), { target: TARGET, acts: current => validateUpgradeProposal(current, payload, TARGET) }))
        .toThrowError(expect.objectContaining({ code: "upgrade_plan_unproposed" }));
      expect(inspectSchema(database).version).toBe(49);
      expect(() => initializeSchema(database, false, at(TARGET), { target: TARGET, acts: current => { validateUpgradeProposal(current, genuine, TARGET); throw new Error("rollback"); } })).toThrow("rollback");
    } finally { database.close(); }
  });

  it("refuses authority acts before the mapping acts as an invalid plan, and inside the transaction as unproposed", async () => {
    const { paths } = authorityWorld();
    const genuine = inspect(paths).plan!;
    const authority = new Set(AUTHORITY_ACT_DOMAIN.kinds.map(kind => kind.kind));
    const payload = { ...genuine, acts: [...genuine.acts.filter(act => authority.has(act.kind)), ...genuine.acts.filter(act => !authority.has(act.kind))] };
    const hash = writePlan(paths, payload);
    const before = files(paths), calls: string[] = [];
    expect(await failure(() => apply(paths, hash, backups(paths, calls)))).toMatchObject({ code: "upgrade_plan_invalid", nextStep: "upgrade inspect", committed: false });
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
    const database = unmanagedFixtureDatabase(copy(paths));
    try {
      expect(() => initializeSchema(database, false, at(TARGET), { target: TARGET, acts: current => validateUpgradeProposal(current, payload, TARGET) }))
        .toThrowError(expect.objectContaining({ code: "upgrade_plan_unproposed" }));
    } finally { database.close(); }
  });

  it("refuses authority decisions in a plan and a domain missing from it", async () => {
    const { paths } = authorityWorld();
    const genuine = inspect(paths).plan!;
    for (const payload of [{ ...genuine, decisions: { ...genuine.decisions, authority: { admin: "x" } } }, { ...genuine, decisions: { mapping: genuine.decisions.mapping } }]) {
      const hash = writePlan(paths, payload);
      expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_invalid", committed: false });
    }
  });
});

describe("authority acts: stops write no plan and change nothing", () => {
  async function stops(paths: AppPaths, code: string) {
    const before = files(paths);
    const refusal = await failure(() => inspect(paths));
    expect(refusal).toMatchObject({ name: "UpgradeError", code, nextStep: "upgrade inspect", committed: false });
    expect(files(paths)).toEqual(before);
    expect(before.plan).toBe("missing");
    return refusal.details!;
  }
  it("lists every column it reads with a storage class", () => {
    expect(AUTHORITY_STORED_COLUMNS.map(entry => entry.table)).toEqual(["remote_principals", "principal_credentials", ...OLD_GRANT_TABLES, "runtime_credential_scopes",
      "reservations", "remote_verification_requests", "remote_verification_attempts", "test_runs", "test_run_summaries"]);
  });
  // Columns the mapping domain also reads (it runs first) are refused by it first; these are read by the authority pass only.
  it.each([
    ["a BLOB revocation time of a credential", (db: Database.Database) => db.exec("UPDATE principal_credentials SET revoked_at=CAST('2025-01-01' AS BLOB) WHERE revoked_at IS NOT NULL"), "principal_credentials"],
    ["a BLOB credential kind", (db: Database.Database) => unchecked(db, "UPDATE principal_credentials SET kind=CAST('agent_token' AS BLOB) WHERE kind='worker_token'"), "principal_credentials"],
    ["a real revision of a delegation", (db: Database.Database) => db.exec("UPDATE runtime_delegations SET revision=1.5 WHERE revoked_at IS NULL"), "runtime_delegations"],
    ["a BLOB attempt phase", (db: Database.Database) => unchecked(db, "UPDATE remote_verification_attempts SET phase=CAST('running' AS BLOB) WHERE id='attempt-running'"), "remote_verification_attempts"],
    ["a BLOB queue time of a run", (db: Database.Database) => db.exec("UPDATE test_runs SET queued_at=CAST(queued_at AS BLOB) WHERE id='history-10'"), "test_runs"],
  ] as const)("refuses %s as malformed", async (_name, mutate, table) => {
    const { paths } = authorityWorld();
    tamper(paths, mutate);
    const details = await stops(paths, "upgrade_authority_malformed");
    expect(details.findings.map(finding => finding.table)).toContain(table);
  });
  it.each([
    ["a principal of unknown kind", "INSERT INTO remote_principals(id,kind,status) VALUES('robot-1','robot','active')", "remote_principals"],
    ["a principal of unknown status", "UPDATE remote_principals SET status='suspended' WHERE kind='agent'", "remote_principals"],
    ["a role binding whose revision cannot advance", "UPDATE knowledge_role_bindings SET revision=9007199254740991 WHERE revoked_at IS NULL", "knowledge_role_bindings"],
    ["a live attempt whose version cannot advance", "UPDATE remote_verification_attempts SET version=9007199254740991 WHERE id='attempt-preparing'", "remote_verification_attempts"],
    ["a queued run with stored JSON the recovery cannot read", "UPDATE test_runs SET args_json='not json' WHERE id='queued-run'", "test_runs"],
  ] as const)("refuses %s as malformed", async (_name, sql, table) => {
    const { paths } = authorityWorld();
    tamper(paths, database => unchecked(database, sql));
    const details = await stops(paths, "upgrade_authority_malformed");
    expect(details.findings[0].table).toBe(table);
  });
  it("refuses a malformed value of an old grant table in its own pass too, when called directly", () => {
    const { paths } = authorityWorld();
    const database = unmanagedFixtureDatabase(copy(paths));
    try {
      database.exec("UPDATE knowledge_project_grants SET revoked_at=CAST('2025-01-01' AS BLOB) WHERE revoked_at IS NOT NULL");
      expect(() => proposeAuthority(database, { schemaVersion: 49, source: 49, target: TARGET }, {}, null, true))
        .toThrowError(expect.objectContaining({ code: "upgrade_authority_malformed", details: expect.objectContaining({ findings: [expect.objectContaining({ table: "knowledge_project_grants" })] }) }));
    } finally { database.close(); }
  });
  it("refuses grants of the new model stored while the upgrade is needed", async () => {
    const { paths, ids } = authorityWorld();
    await apply(paths, inspect(paths).planHash!);
    resume(paths);
    read(paths, database => expect(grantsOf(database)).toEqual([]));
    tamper(paths, database => database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,'admin','installation',NULL,?)").run(ids.owner, PAST));
    const details = await stops(paths, "upgrade_authority_unexpected");
    expect(details.findings).toEqual([{ table: "account_grants", id: ids.owner, problem: expect.stringContaining("upgrade is needed") }]);
  });
  it("refuses more owners than its bound, never truncating (the fence's own bound refuses first through the protocol)", () => {
    const database = new Database(":memory:");
    try {
      initializeSchema(database);
      const insert = database.prepare("INSERT INTO remote_principals(id,kind,status) VALUES(?,'owner','active')");
      for (let index = 0; index <= AUTHORITY_OWNER_LIMIT; index++) insert.run(`owner-${String(index).padStart(3, "0")}`);
      const context = { schemaVersion: 49, source: 49, target: TARGET };
      expect(() => proposeAuthority(database, context, {}, null, true)).toThrowError(expect.objectContaining({ code: "upgrade_plan_bounds" }));
      database.prepare("DELETE FROM remote_principals WHERE id=?").run(`owner-${String(AUTHORITY_OWNER_LIMIT).padStart(3, "0")}`);
      const proposal = proposeAuthority(database, context, {}, null, true);
      expect(proposal.review.owners).toHaveLength(AUTHORITY_OWNER_LIMIT);
      expect(proposal.review.admin).toEqual({ decision: "none", reason: "several_owners" });
    } finally { database.close(); }
  });
});

describe("authority acts: interrupted apply and resume", () => {
  it("rolls back everything, mapping acts and structural steps included, when an authority act fails; after resume, inspect and apply succeed", async () => {
    const { paths, ids } = authorityWorld();
    const noted = inspect(paths).planHash!;
    const before = read(paths, exact);
    let failed = 0;
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, source: string) {
      // The second authority act: the grant revocation and every mapping act already ran.
      if (source.includes("UPDATE principal_credentials SET status='revoked'")) { failed++; throw new Error("fixture act fault"); }
      return exec.call(this, source);
    } as typeof exec);
    expect(await failure(() => apply(paths, noted))).toMatchObject({ code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: false, state: "fenced" });
    expect(failed).toBe(1);
    vi.restoreAllMocks();
    expect({ ...read(paths, exact), security_checkpoint: undefined }).toEqual({ ...before, security_checkpoint: undefined });
    read(paths, database => expect(inspectSchema(database).version).toBe(49));
    resume(paths);
    const inspection = inspect(paths);
    expect(review(inspection).admin).toEqual({ decision: "grant", accountId: ids.owner });
    await apply(paths, inspection.planHash!);
    read(paths, database => expect(grantsOf(database)).toEqual([expect.objectContaining({ account_id: ids.owner, role: "admin" })]));
  });

  it("deletes every grant on resume after a completed upgrade, and the next upgrade grants admin again", async () => {
    const { paths, ids } = authorityWorld();
    const first = inspect(paths);
    await apply(paths, first.planHash!);
    read(paths, database => expect(grantsOf(database)).toHaveLength(1));
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 52 });
    read(paths, database => {
      expect(grantsOf(database)).toEqual([]);
      expect(database.prepare("SELECT state,plan_hash FROM upgrade_marker").get()).toEqual({ state: "pending", plan_hash: null });
      for (const table of ["projects", "remote_project_identities"]) expect(database.prepare(`SELECT count(*) FROM ${table} WHERE parent_project_id IS NOT NULL`).pluck().get()).toBe(0);
    });
    const again = inspect(paths);
    expect(again).toMatchObject({ state: "upgrade_needed", schemaVersion: 52 });
    expect(again.plan!.steps).toEqual([]);
    // Everything was revoked by the first upgrade and the quarantine: nothing more to revoke, and the owner is still the single active one.
    expect(review(again).grantTables.every(table => table.revokes === 0)).toBe(true);
    expect(review(again).credentials.every(entry => entry.active === 0)).toBe(true);
    expect(review(again).admin).toEqual({ decision: "grant", accountId: ids.owner });
    await apply(paths, again.planHash!);
    read(paths, database => expect(grantsOf(database)).toEqual([expect.objectContaining({ account_id: ids.owner, role: "admin", scope_kind: "installation" })]));
  });

  it("keeps targets 50 and 51 free of the authority domain", () => {
    const { paths } = authorityWorld();
    for (const target of [50, 51]) {
      const inspection = inspectSqliteUpgrade(paths, target);
      expect(Object.keys(inspection.review!), String(target)).toEqual(target === 50 ? [] : ["mapping"]);
      const kinds = new Set(AUTHORITY_ACT_DOMAIN.kinds.map(kind => kind.kind));
      expect(inspection.plan!.acts.filter((act: UpgradeAct) => kinds.has(act.kind))).toEqual([]);
    }
  });
});
