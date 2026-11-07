import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerBackup } from "@/server/controller-backup";
import { EventStream } from "@/server/events";
import { nullLogWriter } from "@/server/log-writer";
import { resolveControllerAuthentication } from "@/server/modules/authentication";
import { StatusService } from "@/server/modules/status";
import { TestJobManager } from "@/server/test-job-manager";
import type { ProofFaultInjection } from "../src/index";
import { cleanupRoots, count, OWNER_EMAIL, OWNER_PASSWORD, readCommitted } from "./fixture";
import { cleanupStrictRoots, gate, pauseProvisioning, sleep, strictProof } from "./strict-fixture";

/**
 * Live coexistence of the real pinned provider with admitted controller work on
 * one strict connection gate: core operations wait for (and never interleave
 * with) a held library transaction, background producers persist in order
 * afterwards, and long waits never hold admission.
 */
afterEach(() => { cleanupRoots(); cleanupStrictRoots(); });

const errorCode = async (operation: () => Promise<unknown>) => {
  try { await operation(); } catch (error) { return (error as { code?: string }).code ?? String(error); }
  return undefined;
};
function fakeClient() {
  const writes: string[] = [];
  const client = { write: (chunk: string) => { writes.push(chunk); return true; }, once: () => client, end: () => undefined } as unknown as ServerResponse;
  return { client, writes };
}

describe("live admission of controller work beside the real provider", () => {
  it("does not overwrite cancellation queued after the preflight read", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const tests = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    const observing = gate(), observed = gate();
    const source = { observedAt: new Date().toISOString(), head: "a".repeat(40), branch: "main", dirty: false, statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null };
    tests.configureSourceObserver(async () => {
      observing.open(); await observed.opened;
      return source;
    });
    const saves: string[] = [];
    const save = f.store.saveTestRun.bind(f.store);
    vi.spyOn(f.store, "saveTestRun").mockImplementation((run, key) => { saves.push(run.phase); return save(run, key); });
    let hold: ReturnType<typeof pauseProvisioning> | undefined;
    try {
      const project = await f.run(() => f.store.addProject({ name: "Cancelled preflight", repositoryPath: f.root, port: 3883, executable: "node", args: [] }));
      const marker = join(f.root, "should-not-spawn");
      const run = await f.run(() => tests.enqueue({ projectId: project.id, actor: "local-user", sourceObservation: source,
        worktree: { path: f.root, head: source.head, shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false },
        command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 5_000 }, executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker], cwd: f.root },
        environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] },
      }));
      await observing.opened;
      hold = pauseProvisioning(f, faults, "rollback"); await hold.paused;
      observed.open();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      const cancellation = tests.cancel(run.id, "local-user");
      expect(f.store.admissionSnapshot().queuedCore).toBe(2);
      hold.resume(); await hold.pending;
      await cancellation;
      await vi.waitFor(async () => expect((await f.run(() => tests.status())).running).toBe(0));
      const final = await f.run(() => f.store.getTestRun(run.id));
      expect(final).toMatchObject({ phase: "cancelled", startedAt: null, telemetry: { termination: "cancel" } });
      expect(final?.telemetry?.finalizedAt).toBeTruthy();
      expect(saves).not.toContain("running");
      expect(saves.slice(saves.indexOf("cancelled"))).not.toContain("queued");
      expect(existsSync(marker)).toBe(false);
    } finally { observed.open(); hold?.resume(); await hold?.pending; await tests.shutdown(); await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("queues admitted reads and writes behind a held library transaction and runs each once after rollback or commit", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    try {
      await f.run(() => f.store.addProject({ name: "earlier", repositoryPath: join(f.root, "earlier"), port: 3801, executable: "node", args: [] }));
      for (const outcome of ["rollback", "commit"] as const) {
        const hold = pauseProvisioning(f, faults, outcome);
        await hold.paused;
        let executions = 0;
        const read = f.run(() => { executions++; return f.store.listProjects().map(project => project.name); });
        const write = f.run(() => { executions++; return f.store.addProject({ name: `queued-${outcome}`, repositoryPath: join(f.root, outcome), port: outcome === "commit" ? 3803 : 3802, executable: "node", args: [] }).name; });
        // Unadmitted controller SQL is refused outright instead of joining the provider transaction.
        expect(() => f.store.listProjects()).toThrow(expect.objectContaining({ code: "unadmitted" }));
        await sleep(30);
        expect(executions).toBe(0);
        expect(f.store.admissionSnapshot()).toMatchObject({ providerActive: true, queuedCore: 2, coreActive: 0 });
        hold.resume();
        expect(await hold.pending).toBe(outcome === "rollback" ? "provider_failed" : "committed");
        expect((await read).sort()).toEqual(outcome === "rollback" ? ["earlier"] : ["earlier", "queued-rollback"]);
        expect(await write).toBe(`queued-${outcome}`);
        expect(executions).toBe(2);
        expect(count(f.path, "authentication_ba_user")).toBe(outcome === "rollback" ? 0 : 1);
      }
      expect((await f.run(() => f.store.listProjects().map(project => project.name))).sort()).toEqual(["earlier", "queued-commit", "queued-rollback"]);
    } finally { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("persists a running test's output and exit in order while the provider holds the connection, finalizes it once and keeps the queue usable", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    const tests = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    try {
      const project = await f.run(() => f.store.addProject({ name: "App", repositoryPath: f.root, port: 3811, executable: "node", args: [] }));
      const worktree = { path: f.root, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
      const environment = { environment: {}, mode: "clean" as const, profile: "unit", inheritedServerProfile: null, variableNames: [] };
      const command = (script: string) => ({ preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 10_000 }, executable: process.execPath, args: ["-e", script], cwd: f.root });
      // Waits on stdin-free timers so output and exit land inside the provider hold below.
      const queued = await f.run(() => tests.enqueue({ projectId: project.id, worktree, environment, actor: "local-user",
        command: command("let i=0;const t=setInterval(()=>{console.log('line-'+i++);if(i===4){clearInterval(t);}},60)") }));
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun(queued.id)))?.phase).toBe("running"));
      const hold = pauseProvisioning(f, faults, "rollback");
      await hold.paused;
      // Output, the 250 ms log checkpoint and the exit all happen while admission is unavailable.
      await sleep(700);
      expect(readCommitted(f.path, database => (database.prepare("SELECT phase FROM test_runs WHERE id = ?").get(queued.id) as { phase: string }).phase)).toBe("running");
      hold.resume();
      expect(await hold.pending).toBe("provider_failed");
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun(queued.id)))?.phase).toBe("passed"), { timeout: 5_000 });
      const finished = (await f.run(() => f.store.getTestRun(queued.id)))!;
      expect(finished.logs.filter(line => line.startsWith("line-"))).toEqual(["line-0", "line-1", "line-2", "line-3"]);
      expect(finished.telemetry?.spawnedAt).toBeTruthy();
      expect(finished.telemetry?.finalizedAt).toBeTruthy();
      expect(finished.exitCode).toBe(0);
      // The queue still admits and completes work; nothing latched contention as a storage failure.
      const next = await f.run(() => tests.enqueue({ projectId: project.id, worktree, environment, actor: "local-user", command: command("process.exit(0)") }));
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun(next.id)))?.phase).toBe("passed"), { timeout: 5_000 });
      expect(await f.run(() => f.store.listTestRuns(project.id).length)).toBe(2);
    } finally { await tests.shutdown(); await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("rechecks credentials after waiting, and reports contention instead of an invalid credential", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    try {
      const agent = await f.run(() => f.identity.createAgent(f.ownerActor));
      const issued = await f.run(() => f.identity.issueAgentToken({ principalId: agent.id, label: "fixture" }, f.ownerActor));
      const dependencies = { identity: f.identity };
      const credentials = { bearer: issued.token, legacySecretValid: () => false };
      expect((await f.run(() => resolveControllerAuthentication(dependencies, credentials)))?.kind).toBe("principal");
      const hold = pauseProvisioning(f, faults, "commit");
      await hold.paused;
      // Contention is never disguised as an invalid credential.
      expect(() => resolveControllerAuthentication(dependencies, credentials)).toThrow(expect.objectContaining({ name: "ExclusiveConnectionError" }));
      // FIFO: the revocation was admitted first, so the later authentication sees it.
      const revoked = f.run(() => f.identity.revokeCredential(issued.credential.id, f.ownerActor));
      const authenticated = f.run(() => resolveControllerAuthentication(dependencies, credentials));
      hold.resume();
      expect(await hold.pending).toBe("committed");
      await revoked;
      expect(await authenticated).toBeNull();
    } finally { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("delivers knowledge events after the provider releases, authorized against current grants", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    const events = new EventStream(f.store.admission);
    try {
      const agent = await f.run(() => f.identity.createAgent(f.ownerActor));
      const issued = await f.run(() => f.identity.issueAgentToken({ principalId: agent.id, label: "reader" }, f.ownerActor));
      const actor = await f.run(() => f.identity.authenticateBearer(issued.token));
      const [kept, revoked] = await f.run(() => ["Kept", "Revoked"].map(name => {
        const project = f.identity.createKnowledgeProject({ name }, f.ownerActor);
        f.identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read"] }, f.ownerActor);
        return project.id;
      }));
      const { client, writes } = fakeClient();
      events.add(client, projectId => { f.identity.authorizeKnowledge(actor, projectId, "knowledge:read"); });
      const hold = pauseProvisioning(f, faults, "commit");
      await hold.paused;
      const revocation = f.run(() => f.identity.revokeKnowledgeGrant(agent.id, revoked, f.ownerActor));
      events.publishKnowledge(kept);
      events.publishKnowledge(revoked);
      await sleep(400);
      expect(writes.filter(entry => entry.startsWith("event: knowledge-changed"))).toEqual([]);
      hold.resume();
      expect(await hold.pending).toBe("committed");
      await revocation;
      await vi.waitFor(() => expect(writes.filter(entry => entry.startsWith("event: knowledge-changed"))).toHaveLength(1));
      const delivered = writes.find(entry => entry.startsWith("event: knowledge-changed"))!;
      expect(JSON.parse(delivered.split("data: ")[1]!)).toEqual({ projectIds: [kept] });
    } finally { events.close(); await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("holds no admission during a status long poll, so the provider runs meanwhile", async () => {
    const f = await strictProof({});
    const tests = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    try {
      const project = await f.run(() => f.store.addProject({ name: "Polled", repositoryPath: f.root, port: 3821, executable: "node", args: [] }));
      const processes = { statusSummary: () => ({ phase: "stopped" as const, worktreePath: null, startedAt: null, failureCode: null, ownsProcess: false }), logTail: () => ({ lines: [], retainedLines: 0, truncated: false }) };
      const capacity = { enabled: false, limit: 1, used: 0, available: null, holders: [] };
      const status = new StatusService(f.store, processes, () => capacity, () => tests.status());
      const initial = await f.run(() => status.project(project.id, "agent:fixture"));
      let settled = false;
      const waiting = f.run(() => status.wait({ kind: "project", id: project.id }, initial.cursor, "session", 600)).finally(() => { settled = true; });
      await sleep(20);
      const provisioned = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
      expect(provisioned.subject).toBeTruthy();
      expect(settled).toBe(false);
      expect(await waiting).toMatchObject({ changed: false });
      status.close();
    } finally { await tests.shutdown(); await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("refuses provider resolution from inside admitted core work instead of deadlocking", async () => {
    const f = await strictProof({});
    try {
      expect(await f.run(() => errorCode(() => f.runtime.resolve(new Headers())))).toBe("reentrant");
      expect(await f.runtime.resolve(new Headers())).toBeNull();
    } finally { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });

  it("waits for a queued backup and the held provider before closing, and keeps ownership until then", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    await f.run(() => f.store.addProject({ name: "backed-up", repositoryPath: join(f.root, "b"), port: 3831, executable: "node", args: [] }));
    const hold = pauseProvisioning(f, faults, "rollback");
    await hold.paused;
    const backup = f.run(() => ({ pending: f.store.backup(join(f.root, "copy.sqlite3")) })).then(({ pending }) => pending);
    const closing = f.store.closeAfterDrain(5_000);
    await sleep(50);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    hold.resume();
    expect(await hold.pending).toBe("provider_failed");
    await backup;
    await closing;
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    expect(readCommitted(join(f.root, "copy.sqlite3"), database => (database.prepare("SELECT count(*) n FROM projects").get() as { n: number }).n)).toBe(1);
    await f.runtime.dispose();
  });

  it("tracks a timed-out library continuation until it settles, denies its late SQL and reports unconfirmed disposal", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults, { borrowTimeoutMs: 150 });
    try {
      const hold = pauseProvisioning(f, faults, "commit");
      await hold.paused;
      expect(await hold.pending).toBe("expired");
      // Core work proceeds once the forced release rolled the library write back.
      expect(await f.run(() => f.store.listProjects().length)).toBe(0);
      await expect(f.runtime.dispose({ timeoutMs: 50 })).rejects.toMatchObject({ code: "disposal_unconfirmed" });
      hold.resume();
      expect(await f.store.authenticationProviderStorage().drain(2_000)).toBe(true);
      expect(count(f.path, "authentication_ba_user")).toBe(0);
      expect(count(f.path, "authentication_provider_subjects")).toBe(0);
      expect(f.evidence.events).toEqual([]);
    } finally { await f.store.closeAfterDrain(); }
  });

  it("queues an admitted controller backup behind a provider hold and completes it afterwards", async () => {
    const faults: ProofFaultInjection = {};
    const f = await strictProof(faults);
    try {
      const hold = pauseProvisioning(f, faults, "rollback");
      await hold.paused;
      const copy = f.run(() => createControllerBackup(f.store, join(f.root, "verified"), { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") }));
      await sleep(20);
      expect(existsSync(join(f.root, "verified"))).toBe(false);
      hold.resume();
      await hold.pending;
      expect((await copy).database.schemaVersion).toBe(47);
    } finally { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
  });
});
