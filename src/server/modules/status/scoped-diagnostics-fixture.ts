import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService } from "@/server/control-service";
import { SqliteStateStore } from "@/server/sqlite-store";
import { IdentityService } from "../identity";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import type { TestRun } from "@/shared/contracts";

export const cleanup: Array<() => void> = [];
export function diagnosticsFixture(actions: RuntimeAction[] = ["logs:read", "storage:read", "capacity:read", "tests:run"]) {
  const root = mkdtempSync(join(tmpdir(), "scoped-diagnostics-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanup.push(() => store.close());
  let now = Date.now();
  const identity = new IdentityService(store, () => new Date(now).toISOString(), undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = store.addProject({ name: "Granted", repositoryPath: root, port: 3711, executable: "node", args: [] });
  const foreign = store.addProject({ name: "Secret foreign project", repositoryPath: "/secret", port: 3712, executable: "node", args: [] });
  const agent = identity.createAgent(owner);
  const grant = (next: RuntimeAction[]) => identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions: next,
    expectedRevision: store.getRuntimeDelegation(agent.id, project.id)?.revision ?? 0 }, owner);
  grant(actions);
  const issue = () => identity.issueRuntimeCredential({ principalId: agent.id, label: "diagnostics", expiresAt: new Date(now + 60_000).toISOString(),
    projects: [{ projectId: project.id, actions }] }, owner);
  const issued = issue(), actor = identity.authenticateBearer(issued.token);
  let onLogs: (() => void) | undefined;
  const processes = { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null, ownsProcess: false, failureCode: null }),
    logTail: () => { onLogs?.(); return { lines: ["application failure", `Authorization: Bearer ${issued.token}`], retainedLines: 2, truncated: false }; } };
  const service = new ControlService(store, {} as never, processes as never, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, identity);
  const run: TestRun = { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", projectId: project.id, worktreePath: root, worktreeHead: "a", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "agent:mcp:original", phase: "failed", queuePosition: null,
    executable: "secret command", args: [], cwd: root, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    exitCode: 1, signal: null, error: "private internal exception", logs: ["test failed", `cookie=${issued.token}`], environmentMode: "clean",
    environmentProfile: "unit", inheritedServerProfile: null, environmentVariableNames: ["PRIVATE_ENV"], source: legacySourceEvidence() };
  store.saveTestRun(run, "key", { principalId: actor.principalId, credentialId: actor.credentialId, projectId: project.id,
    sessionOwner: run.actor, reservationId: null, leaseTokenHash: null });
  store.saveWorktreeStorage({ projectId: project.id, worktreePath: root, totalBytes: 1234, nextBytes: 12, nextCacheBytes: 2,
    nodeModulesBytes: 300, measuredAt: new Date().toISOString(), topDirectories: [{ name: "secret-file-name", bytes: 1 }] });
  return { store, identity, owner, project, foreign, actor, issued, issue, service, grant,
    expire: () => { now += 60_001; }, onLogs: (hook: () => void) => { onLogs = hook; } };
}
