/** Investigation only: every path comes from a test-owned directory beneath TMPDIR.
 * No listeners, development server, service access, or production instrumentation.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { TestRun } from "../src/shared/contracts";
import type { HumanRuntimeAuthority } from "../src/server/modules/identity";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const [mode, inputRoot, operation = "bearer", edge = "none", signal = "SIGKILL"] = process.argv.slice(2);
const root = resolve(inputRoot ?? "");
if (!inputRoot || !root.startsWith(resolve(tmpdir()) + sep) || !fs.existsSync(join(root, "synthetic-only"))) {
  throw new Error("Requires an explicitly marked synthetic installation beneath this run's TMPDIR");
}
const databasePath = join(root, "data", "state.sqlite3");
const witness = `${databasePath}.security/witness.json`;
let armed = false, hit = false, pendingAt = 0n, visibleAt = 0n;
const durations: number[] = [], visibleDurations: number[] = [];
const rename = fs.renameSync, fsync = fs.fsyncSync;
let published: string | undefined;
function stop(point: string) {
  if (!armed || hit || edge !== point) return;
  hit = true;
  fs.writeSync(1, JSON.stringify({ boundary: point, signal }) + "\n");
  process.kill(process.pid, signal as NodeJS.Signals);
}
fs.renameSync = ((from, to) => {
  const state = String(to) === witness ? JSON.parse(fs.readFileSync(from, "utf8")).payload.state as string : undefined;
  if (armed && state === "pending") {
    stop("before-pending");
    pendingAt = process.hrtime.bigint();
  }
  if (armed && state === "confirmed") stop("after-commit");
  rename(from, to);
  if (state) published = state;
  if (armed && state === "pending") visibleAt = process.hrtime.bigint();
  if (armed && state === "confirmed") visibleDurations.push(Number(process.hrtime.bigint() - visibleAt) / 1e6);
}) as typeof fs.renameSync;
fs.fsyncSync = fd => {
  fsync(fd);
  if (armed && fs.realpathSync(`/proc/self/fd/${fd}`) === `${databasePath}.security`) {
    if (published === "pending") stop("before-row");
    if (published === "confirmed") {
      durations.push(Number(process.hrtime.bigint() - pendingAt) / 1e6);
      stop("after-confirmed");
    }
  }
};
syncBuiltinESMExports();

const { SqliteStateStore } = await import("../src/server/infrastructure/sqlite/sqlite-state-store");
const { SECURITY_TABLES } = await import("../src/server/infrastructure/sqlite/security-fence-migration");
const { IdentityService } = await import("../src/server/modules/identity");
const { AuthenticationService } = await import("../src/server/modules/authentication");
const { AuthenticationProtectionQueries } = await import("../src/server/infrastructure/sqlite/authentication-protection-queries");
const { runSecurityFenceCommand } = await import("../src/cli/security-fence");
const { resolveAppPaths } = await import("../src/server/paths");
const { legacySourceEvidence } = await import("../src/server/test-source-attribution");
const { createControllerShutdown } = await import("../src/server/bootstrap/controller-shutdown");
const { acquireControllerLock } = await import("../src/server/controller-lock");
const { openControllerStore } = await import("../src/server/controller-storage");
const { DevVaultCipher } = await import("../src/server/modules/dev-vault/crypto");
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
function snapshot() {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = Object.fromEntries(SECURITY_TABLES.map(table => {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      return [table, { count: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }];
    }));
    const scalar = (sql: string) => db.prepare(sql).get();
    return { tables, checkpoint: scalar("SELECT * FROM security_checkpoint"),
      authority: {
        credentials: scalar("SELECT count(*) total,sum(status='active') active FROM principal_credentials"),
        passwords: scalar("SELECT count(password) passwords,count(accessToken) accessTokens FROM authentication_ba_account"),
        factors: scalar("SELECT sum(twoFactorEnabled) enabled FROM authentication_ba_user"),
        policies: scalar("SELECT generation,policy_revision,totp_selected,passkey_selected FROM authentication_account_policies"),
        contexts: scalar("SELECT sum(used) used FROM authentication_factor_contexts"),
        receipts: scalar("SELECT sum(state='charged') charged,sum(state='failed') failed FROM authentication_factor_receipts"),
        authentication: scalar("SELECT value_json FROM controller_settings WHERE key='authentication'"),
        grants: Object.fromEntries(["knowledge_project_grants", "knowledge_role_bindings", "runtime_delegations", "runtime_human_memberships", "remote_principal_project_grants", "remote_worker_project_grants"].map(table => [table, scalar(`SELECT count(*) total,sum(revoked_at IS NULL) active FROM ${table}`)])),
      } };
  } finally { db.close(); }
}
const emit = (value: unknown) => fs.writeSync(1, JSON.stringify(value) + "\n");
if (mode === "snapshot") { emit(snapshot()); process.exit(0); }
if (mode === "open") {
  try { const store = await openControllerStore(databasePath, { backupBeforeMigration: false, applicationVersion: "investigation", attachmentDirectory: join(root, "attachments") }); store.close(); emit({ opened: true }); }
  catch (error) { emit({ opened: false, code: (error as {code?: string}).code, message: (error as Error).message }); process.exitCode = 1; }
} else if (mode === "recover") {
  const before = snapshot(), paths = { ...resolveAppPaths(join(root, "data"), join(root, "state"), { environment: {} }), databasePath };
  let preflight = "";
  runSecurityFenceCommand(["fence", "inspect"], paths, line => { preflight = JSON.parse(line).preflight; emit({ inspect: JSON.parse(line) }); });
  runSecurityFenceCommand(["fence", "resume", "--expect", preflight, "--mode", "token"], paths, line => emit({ resume: JSON.parse(line) }));
  emit({ recovery: { before, after: snapshot() } });
} else if (mode === "write" || mode === "measure") {
  const store = new SqliteStateStore(databasePath);
  const project = store.addProject({ name: "Synthetic", repositoryPath: root, port: 3901, executable: "node", args: [] });
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store), owner = identity.bootstrapOwnerSession();
  const installation = new AuthenticationService(store).generateToken("local-cli").token;
  store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "local-cli");
  store.savePrincipal({ id: "worker-principal", kind: "worker", status: "active" }, "local-cli");
  store.humanAccounts().createHumanPrincipal({ id: "human", kind: "human", status: "active" }, "local-cli");
  const now = new Date().toISOString(), deadline = new Date(Date.now() + 3600_000).toISOString();
  const a: HumanRuntimeAuthority = { principalId: "human", sessionKey: "a".repeat(64), evidenceKey: "b".repeat(64), generation: 1,
    membershipRevision: 1, permissions: ["claims:manage", "runtime:control", "tests:run"], deadline };
  const kp = { id: "knowledge", name: "Synthetic", status: "active" as const, revision: 1, createdAt: now, updatedAt: now };
  store.saveKnowledgeProject(kp, "local-cli");
  store.saveKnowledgeProjectGrant({ principalId: "agent", projectId: kp.id, permissions: ["knowledge:read"], revokedAt: null }, "local-cli");
  store.saveKnowledgeRoleBinding({ principalId: "agent", projectId: kp.id, role: "reader", revision: 1, updatedAt: now, revokedAt: null }, 0, "local-cli");
  store.saveRemoteWorker({ id: "worker", principalId: "worker-principal", name: "Synthetic", status: "active", lastContactAt: null }, "local-cli");
  store.saveRemoteProjectIdentity({ id: "remote", name: "Synthetic", sourceRemote: "https://fixture.invalid/repo", status: "active" }, "local-cli");
  store.saveRemotePrincipalProjectGrant({ principalId: "agent", projectId: "remote", permissions: ["submit"], revokedAt: null }, "local-cli");
  store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "remote", localProjectId: project.id, presetIds: ["node:test"], revokedAt: null }, "local-cli");
  store.saveRuntimeDelegation({ principalId: "agent", projectId: project.id, sponsorId: owner.principalId, actions: ["projects:read"], revision: 1, expiresAt: null, updatedAt: now, revokedAt: null }, 0, "local-cli");
  store.issueScopedCredential({ id: "machine", principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: "fixture", verifierHash: "a".repeat(64), status: "active", expiresAt: null, createdAt: now, revokedAt: null, lastUsedAt: null }, [{ credentialId: "machine", projectId: project.id, actions: ["projects:read"], createdAt: now }], "local-cli");
  store.runtimeMemberships().saveRuntimeMembership({ principalId: "human", scope: { kind: "runtime-project", id: project.id }, role: "operator", permissions: ["claims:manage"], expectedRevision: 0 }, "local-cli", now);
  const provider = store.authenticationProviderStorage();
  async function sql(source: string) {
    await provider.borrow(async () => { const c = provider.createProviderConnection(); try { c.prepare(source).run([]); } finally { c.close(); } });
  }
  // Fixture material uses the real guarded provider connection, never an independent writer.
  for (const source of [
    `INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES('subject','Synthetic','fixture.invalid',1,'${now}','${now}',1)`,
    `INSERT INTO authentication_provider_subjects VALUES('better-auth','subject','${owner.principalId}','active','${now}',NULL)`,
    `INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,accessToken,refreshToken,idToken,createdAt,updatedAt) VALUES('account','subject','credential','subject','synthetic-password','synthetic-access','synthetic-refresh','synthetic-id','${now}','${now}')`,
    `INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session','${deadline}','synthetic-session','${now}','${now}','subject')`,
    `INSERT INTO authentication_ba_verification VALUES('verification','fixture','synthetic','${deadline}','${now}','${now}')`,
    `INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId,verified) VALUES('totp','synthetic-secret','synthetic-codes','subject',1)`,
    `INSERT INTO authentication_ba_passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES('passkey','synthetic-key','subject','credential',0,'singleDevice',0)`,
    `INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,1,1,'${now}')`,
    `INSERT INTO authentication_totp_steps VALUES('better-auth','subject',1)`,
    `INSERT INTO authentication_passkey_trust VALUES('credential','passkey','better-auth','subject','handle','fingerprint',1,'${now}')`,
    `INSERT INTO authentication_factor_contexts(capability,provider_id,purpose,subject,deadline,used) VALUES('capability','better-auth','totp_login','subject',9999999999999,0)`,
    `INSERT INTO authentication_factor_budgets VALUES('better-auth','totp','subject',1,1)`,
    `INSERT INTO authentication_factor_receipts(attempt_id,provider_id,capability,purpose,subject,principal_id,credential,binding,generation,policy_revision,epoch,deadline,state) VALUES('attempt','better-auth','capability','totp_login','subject','${owner.principalId}','totp','synthetic-binding',1,1,1,9999999999999,'charged')`,
    `INSERT INTO authentication_session_evidence VALUES('session','better-auth','subject','password','${now}','${deadline}',1,1,NULL,NULL,'session-attempt')`,
    `INSERT INTO authentication_session_issuance VALUES('session','may_publish','${deadline}')`,
  ]) await sql(source);
  const run: TestRun = { id: "run", projectId: project.id, worktreePath: root, worktreeHead: "a", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "fixture", phase: "queued", queuePosition: null,
    executable: "node", args: [], cwd: root, queuedAt: now, startedAt: null, finishedAt: null, exitCode: null, signal: null, error: null, logs: [],
    environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null, environmentVariableNames: [], source: legacySourceEvidence() };
  let reservationId = "";
  if (["renew", "release", "expiry"].includes(operation)) {
    reservationId = store.acquireReservation({ projectId: project.id, worktreePath: root, kind: "agent", owner: "fixture", ttlSeconds: 60, maximumLifetimeSeconds: 3600, leaseTokenHash: "c".repeat(64), idempotencyKey: "claim-key" }).id;
    if (operation === "expiry") await sql(`UPDATE reservations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='${reservationId}'`);
  }
  if (["human-claim", "human-renew", "human-release"].includes(operation)) store.humanRuntime().begin(a, project.id, "key", "c".repeat(64));
  if (["human-renew", "human-release"].includes(operation)) reservationId = store.humanRuntime().claim(a, { projectId: project.id, worktreePath: root, reason: "fixture", key: "key", fingerprint: "c".repeat(64), ttlSeconds: 60 }).id;
  if (operation === "test-persist" || mode === "measure") store.saveTestRun(run);
  const request = { id: "request", projectId: "remote", workerId: "worker", requestedBy: "agent", commitSha: "a".repeat(40), presetId: "node:test", idempotencyKey: "remote-key", phase: "pending" as const, createdAt: now, updatedAt: now };
  const attempt = { id: "remote-attempt", requestId: "request", workerId: "worker", sequence: 1, phase: "assigned" as const, version: 1, localRunId: null, executedCommitSha: null, failureKind: null, errorCode: null, acceptedAt: now, lastReportedAt: now, finishedAt: null };
  if (["remote-assign", "remote-cancel", "remote-report"].includes(operation)) store.createOrReplayRemoteVerificationRequest(request);
  if (operation === "remote-report") store.createOrReplayRemoteVerificationAttempt(attempt);
  if (operation === "bearer") {
    store.acquireReservation({ projectId: project.id, worktreePath: root, kind: "human", owner: "fixture" });
    store.saveTestRun({ ...run, phase: "running", startedAt: now });
    store.createOrReplayRemoteVerificationRequest(request);
    store.createOrReplayRemoteVerificationAttempt(attempt);
  }
  let proof: Awaited<ReturnType<typeof import("../packages/auth-provider-better-auth-proof/test/fixture").loadProof>> | undefined;
  let client: import("../packages/auth-provider-better-auth-proof/test/fixture").Client | undefined;
  let totpCode: string | undefined;
  if (["provider-sign-in", "provider-totp-verify"].includes(operation)) {
    const fixture = await import("../packages/auth-provider-better-auth-proof/test/fixture");
    // Finite fixture inputs, matching the existing provider proof. These configure
    // the synthetic provider only; no resource guard environment is changed.
    const factors = operation === "provider-totp-verify" ? { rpId: "controller.test", rpName: "Synthetic", limits: {
      totp: { attempts: 32, windowMs: 60_000 }, passkey: { attempts: 32, windowMs: 60_000 }, ticketMs: 15_000, stagingMs: 600_000, capacity: 256, pruneBatch: 16,
      issuance: { perPeer: { attempts: 64, windowMs: 60_000 }, global: { attempts: 128, windowMs: 60_000 }, peers: 32, nativeChallenges: 256, reservedContexts: 8 },
      webauthn: { credentialIdBytes: 2048, clientDataBytes: 2048, attestationBytes: 16_384, authenticatorDataBytes: 8192, publicKeyBytes: 2048, signatureBytes: 2048, userHandleBytes: 64, challengeBytes: 64, transports: 8, credentials: 16, responseBytes: 65_536 },
    } } : undefined;
    proof = await fixture.loadProof(store, undefined, undefined, factors);
    await proof.runtime.provisionLocal({ principalId: "human", email: "human@fixture.invalid", name: "Synthetic", password: fixture.OWNER_PASSWORD, actor: "local-cli" });
    client = new fixture.Client(proof.runtime);
    if (operation === "provider-totp-verify") {
      if ((await client.signIn(undefined, "human@fixture.invalid")).status !== 200) throw new Error("Synthetic TOTP password sign-in failed");
      const enabled = await client.call("/two-factor/enable", { body: { password: fixture.OWNER_PASSWORD } });
      if (enabled.status !== 200) throw new Error(`Synthetic TOTP enrollment failed: ${enabled.status}`);
      const { Authenticator } = await import("../packages/auth-provider-better-auth-proof/test/factor-fixture");
      totpCode = new Authenticator((await enabled.json()).totpURI).code();
    }
  }
  fs.writeFileSync(join(root, "before.json"), JSON.stringify(snapshot()));
  const protection = () => new AuthenticationProtectionQueries((store as unknown as { database: import("better-sqlite3").Database }).database, "better-auth");
  async function write(iteration = 0) {
    switch (operation) {
      case "bearer": identity.authenticateBearer(owner.token); break;
      case "test-persist": store.saveTestRun({ ...run, logs: [`iteration ${iteration}`] }); break;
      case "claim": store.acquireReservation({ projectId: project.id, worktreePath: root, kind: "human", owner: "fixture" }); break;
      case "renew": store.renewAgentReservation(project.id, reservationId, "fixture", "c".repeat(64), 120); break;
      case "release": store.releaseAgentReservation(project.id, reservationId, "fixture", "c".repeat(64)); break;
      case "expiry": store.getActiveReservation(project.id); break;
      case "human-intent": store.humanRuntime().begin(a, project.id, "key", "c".repeat(64)); break;
      case "human-claim": store.humanRuntime().claim(a, { projectId: project.id, worktreePath: root, reason: "fixture", key: "key", fingerprint: "c".repeat(64), ttlSeconds: 60 }); break;
      case "human-renew": store.humanRuntime().renew(reservationId, new Date(Date.now() + 120_000).toISOString()); break;
      case "human-release": store.humanRuntime().release(reservationId, "fixture"); break;
      case "settings": store.setTestQueueSettings({ limit: 2 }); break;
      case "project": store.setSelectedWorktree(project.id, join(root, "branch")); break;
      case "knowledge-project": store.saveKnowledgeProject({ ...kp, name: "Changed", revision: 2 }, "local-cli"); break;
      case "grant": store.saveKnowledgeProjectGrant({ principalId: "agent", projectId: kp.id, permissions: ["knowledge:read", "knowledge:write"], revokedAt: null }, "local-cli"); break;
      case "worker-contact": store.remoteConnection.contact("worker", deadline); break;
      case "vault": if (!store.devVault.commit(project.id, 0, new DevVaultCipher({ key: () => Buffer.alloc(32, 7) }).seal({ synthetic: true }, project.id, "state", 1))) throw new Error("Synthetic vault write was ignored"); break;
      case "provider-session-storage": await sql(`INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('new-session','${deadline}','new-synthetic-session','${now}','${now}','subject')`); break;
      case "session-issuance": provider.sessionIssuance().insertPending("session", deadline); break;
      case "factor-step": protection().advanceStep("subject", 2); break;
      case "factor-budget": protection().charge("totp", "subject", 1, 2); break;
      case "factor-receipt": protection().finishReceipt("attempt", "failed", null); break;
      case "installation-token": new AuthenticationService(store).rotateToken("local-cli"); break;
      case "remote-submit": store.createOrReplayRemoteVerificationRequest(request); break;
      case "remote-assign": store.createOrReplayRemoteVerificationAttempt(attempt); break;
      case "remote-cancel": store.remoteConnection.requestCancellation(request.id, now); break;
      case "remote-report": store.remoteConnection.saveReport({ attemptId: attempt.id, sequence: 1, phase: "running", localRunId: "synthetic-run", logs: [] }); break;
      case "worker-receipt": store.remoteConnection.accept({ assignment: { requestId: "request", attemptId: attempt.id, workerId: "worker", projectId: "remote", presetId: "node:test", commitSha: request.commitSha }, localRunId: "synthetic-run", reports: [], acknowledgedSequence: 0, cancellationRequested: false }); break;
      case "human-test": {
        const actor = "human:test:human";
        store.saveTestRun({ ...run, actor }, "human-test-key", { kind: "human", projectId: project.id, sessionOwner: actor, authority: a,
          reference: { principalId: a.principalId, sessionKey: a.sessionKey, evidenceKey: a.evidenceKey, generation: a.generation, deadline, nativeSessionId: "session" }, reservationId: null, fingerprint: "c".repeat(64) });
        break;
      }
      case "agent-test": store.saveTestRun({ ...run, actor: "agent:mcp:fixture" }, "agent-test-key", { principalId: "agent", credentialId: "machine", projectId: project.id, sessionOwner: "agent:mcp:fixture", reservationId: null, leaseTokenHash: null }); break;
      case "runtime-credential": store.issueScopedCredential({ id: "scoped", principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: "fixture", verifierHash: "a".repeat(64), status: "active", expiresAt: null, createdAt: now, revokedAt: null, lastUsedAt: null }, [{ credentialId: "scoped", projectId: project.id, actions: ["projects:read"], createdAt: now }], "local-cli"); break;
      case "membership": store.runtimeMemberships().saveRuntimeMembership({ principalId: "human", scope: { kind: "runtime-project", id: project.id }, role: "reader", permissions: ["projects:read"], expectedRevision: 1 }, "local-cli", now); break;
      case "factor-reset": (store as unknown as { database: import("better-sqlite3").Database }).database.transaction(() => protection().resetLocalFactors("subject"))(); break;
      case "passkey-stage": protection().insertStaged({ credential: "credential", nativeId: "passkey", capability: "capability", subject: "subject", handle: "handle", fingerprint: "fingerprint", generation: 1, policyRevision: 1, sessionId: "session", originalDeadline: deadline, deadline: Date.now() + 600_000 }); break;
      case "provider-sign-in": { const response = await client!.signIn(undefined, "human@fixture.invalid"); if (response.status !== 200) throw new Error(`sign-in status ${response.status}: ${await response.text()}`); break; }
      case "provider-totp-verify": { const response = await client!.call("/two-factor/verify-totp", { body: { code: totpCode } }); if (response.status !== 200) throw new Error(`TOTP status ${response.status}: ${await response.text()}`); break; }
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  }
  // Issuance is an INSERT, so give it a native session without an existing marker.
  if (operation === "session-issuance") { await sql("DELETE FROM authentication_session_issuance WHERE session_id='session'"); fs.writeFileSync(join(root, "before.json"), JSON.stringify(snapshot())); }
  const controllerLock = acquireControllerLock(join(root, "synthetic-controller.lock"));
  const closer = { close() {} };
  const shutdown = createControllerShutdown({ service: { closeAdmission() {}, shutdown: () => store.closeAfterDrain() },
    stopping() {}, userSchedules: undefined, backups: closer, remoteVerification: null, mcp: null,
    controller: closer, adminSocket: closer, authenticationProvider: proof?.runtime, removeServiceAccess() {}, controllerLock });
  process.once("SIGTERM", () => { void shutdown().then(() => { emit({ graceful: true }); process.exit(0); }, error => { throw error; }); });
  armed = true;
  if (mode === "measure") {
    for (let i = 0; i < 220; i++) await write(i);
    armed = false;
    const stats = (all: number[]) => { const samples = all.slice(20), sorted = [...samples].sort((a,b) => a-b); return { n: samples.length, medianMs: (sorted[99]! + sorted[100]!) / 2, p95Ms: sorted[189], maxMs: sorted.at(-1), meanMs: samples.reduce((a,b) => a+b,0) / samples.length, samples }; };
    emit({ measurement: operation, publication: stats(durations), visible: stats(visibleDurations) });
    store.close();
    controllerLock.release();
  } else {
    await write();
    armed = false;
    if (edge !== "none" && !hit) throw new Error(`Did not hit ${operation}/${edge}`);
    if (signal === "SIGTERM" && hit) await new Promise(resolve => setTimeout(resolve, 100));
    else { await proof?.runtime.dispose(); store.close(); controllerLock.release(); emit({ completed: true, installationTokenPresent: !!installation }); }
  }
} else { throw new Error(`Unknown mode: ${mode}`); }
