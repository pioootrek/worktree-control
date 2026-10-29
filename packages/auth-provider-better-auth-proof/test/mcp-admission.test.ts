import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { ProcessManager } from "@/server/process-manager";
import { McpRuntime } from "@/server/transports/mcp/mcp-runtime";
import { McpSessionGovernor, type GovernedMcpSession, type McpSessionClock } from "@/server/modules/mcp-sessions";
import { KnowledgeService } from "@/server/modules/knowledge";
import type { ControllerAuthentication } from "@/server/modules/identity";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, sleep, strictProof, type StrictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
/** Manual session timers only: real gate deadlines and real SQLite remain untouched. */
class SessionClock implements McpSessionClock {
  time = Date.now(); next = 0;
  timers = new Map<number, { callback: () => void; at: number }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => { const id = ++this.next; this.timers.set(id, { callback, at: this.time + delay }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); } }
}
async function protocol(f: StrictProof, scoped = false) {
  const clock = new SessionClock(), governor = new McpSessionGovernor({}, clock), diagnostic = vi.fn();
  const project = await f.run(() => f.store.addProject({ name: "MCP fixture", repositoryPath: f.root, port: 3894, executable: "", args: [], launchPreset: "node" }));
  const actor = await f.run(() => {
    const agent = f.identity.createAgent(f.ownerActor);
    if (scoped) {
      const actions = ["projects:read", "claims:manage", "runtime:control"] as const;
      f.identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions: [...actions], expectedRevision: 0 }, f.ownerActor);
      const issued = f.identity.issueRuntimeCredential({ principalId: agent.id, label: "MCP fixture", projects: [{ projectId: project.id, actions: [...actions] }] }, f.ownerActor);
      return f.identity.authenticateBearer(issued.token);
    }
    const issued = f.identity.issueAgentToken({ principalId: agent.id, label: "MCP fixture" }, f.ownerActor);
    return f.identity.authenticateBearer(issued.token);
  });
  const worktree = { path: f.root, head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const processes = new ProcessManager();
  const service = new ControlService(f.store, { list: async () => [worktree] } as never, processes, undefined, { resolve: () => ({ preset: "node", executable: "node", args: [], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) }, undefined, undefined, undefined, undefined, undefined, new KnowledgeService(f.store, f.identity), undefined, f.identity);
  const runtime = new McpRuntime(service, diagnostic, f.identity, undefined, governor);
  const admitted = governor.admit(`principal:${actor.credentialId}`);
  if (!admitted.admitted) throw new Error("fixture session refused");
  // Use the actual session factory and protocol registration; replace only the wire.
  // No admission is added around calls: the production SDK handler wrapper must supply it.
  const session = (runtime as unknown as { createSession(auth: ControllerAuthentication, governed: GovernedMcpSession): {
    server: McpServer; owner: string; closing: boolean; transport: { close(): Promise<void> }; claims: Map<string, unknown>;
  } }).createSession({ kind: "principal", actor }, admitted.session);
  session.owner = "agent:mcp:strict-in-memory-fixture";
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "strict-proof", version: "1" });
  await session.server.connect(serverTransport); await client.connect(clientTransport);
  const close = async () => { await session.transport.close(); await client.close(); await session.server.close(); admitted.session.markClosed(); };
  return { client, clock, diagnostic, actor, project, session, processes, close };
}

describe("strict in-memory MCP protocol admission", () => {
  it.each(["commit", "rollback"] as const)("waits for provider %s and reads current identity after release", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), mcp = await protocol(f);
    const hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused; let settled = false;
      const pending = mcp.client.callTool({ name: "get_identity", arguments: {} }).finally(() => { settled = true; });
      await sleep(20); expect(settled).toBe(false);
      hold.resume(); await hold.pending;
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain(mcp.actor.principalId);
    } finally { hold.resume(); await hold.pending; await mcp.close(); await closeStrictProof(f); }
  });

  it("rejects a queued call after credential revocation, without exposing cached identity", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), mcp = await protocol(f);
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = f.run(() => f.identity.revokeCredential(mcp.actor.credentialId, f.ownerActor));
      const pending = mcp.client.callTool({ name: "get_identity", arguments: {} });
      hold.resume(); await hold.pending; await revoke;
      const result = await pending;
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(mcp.actor.principalId);
    } finally { hold.resume(); await hold.pending; await mcp.close(); await closeStrictProof(f); }
  });

  it.each(["renew", "revoke", "close"] as const)("handles automatic renewal queued behind provider: %s", async mode => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { admissionTimeoutMs: 80 }), mcp = await protocol(f, true);
    const claimResult = await mcp.client.callTool({ name: "claim_project", arguments: { projectId: mcp.project.id, worktreePath: f.root, reason: "strict fixture", idempotencyKey: "claim-once", ttlSeconds: 30, start: false } });
    expect(claimResult.isError, JSON.stringify(claimResult)).not.toBe(true);
    const before = await f.run(() => f.store.getActiveReservation(mcp.project.id));
    expect(before).not.toBeNull(); expect(mcp.session.claims.size).toBe(1);
    const hold = pauseProvisioning(f, faults, "rollback");
    let closed = false;
    try {
      await hold.paused; mcp.clock.advance(10_000);
      await vi.waitFor(() => expect(mcp.diagnostic).toHaveBeenCalledWith("mcp.claim_auto_renew_deferred", expect.objectContaining({ reason: "database-busy" })));
      expect(mcp.session.claims.size).toBe(1);
      let revoke: Promise<unknown> | undefined;
      if (mode === "revoke") revoke = f.run(() => f.identity.revokeCredential(mcp.actor.credentialId, f.ownerActor));
      if (mode === "close") { await mcp.close(); closed = true; }
      // The retried callback must recheck session and current authority after admission.
      mcp.clock.advance(1_000);
      hold.resume(); await hold.pending; await revoke;
      if (mode === "renew") {
        await vi.waitFor(() => expect(mcp.diagnostic).not.toHaveBeenCalledWith("mcp.claim_auto_renew_failed", expect.anything()));
        await vi.waitFor(() => expect(mcp.clock.timers.size).toBeGreaterThan(1));
        expect(mcp.session.claims.size).toBe(1);
      } else {
        if (mode === "revoke") await vi.waitFor(() => expect(mcp.session.claims.size).toBe(0));
        const after = await f.run(() => f.store.getActiveReservation(mcp.project.id));
        expect(after?.expiresAt).toBe(before?.expiresAt);
      }
    } finally { hold.resume(); await hold.pending; if (!closed) await mcp.close(); await closeStrictProof(f); }
  });

  it("rechecks scoped authority after readiness re-admission and refuses a retained retry without repeating spawn", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), mcp = await protocol(f, true);
    const ready = gate(), entered = gate();
    const start = vi.spyOn(mcp.processes, "start").mockImplementation(async (project, path, beforeSpawn) => {
      expect(project.id).toBe(mcp.project.id); expect(path).toBe(f.root);
      beforeSpawn?.(); entered.open(); await f.store.admission.idle(() => ready.opened);
    });
    const claim = await mcp.client.callTool({ name: "claim_project", arguments: { projectId: mcp.project.id, worktreePath: f.root, reason: "readiness fixture", idempotencyKey: "claim", start: false } });
    expect(claim.isError).not.toBe(true);
    const reservationId = (await f.run(() => f.store.getActiveReservation(mcp.project.id)))!.id;
    const input = { name: "start_project", arguments: { projectId: mcp.project.id, reservationId, idempotencyKey: "start-once" } };
    const operation = mcp.client.callTool(input); await entered.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoked = f.run(() => f.identity.revokeCredential(mcp.actor.credentialId, f.ownerActor));
      ready.open(); await sleep(20); expect(start).toHaveBeenCalledOnce();
      hold.resume(); await hold.pending; await revoked;
      const result = await operation;
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("runtime_access_denied");
      expect((await mcp.client.callTool(input)).isError).toBe(true);
      expect(start).toHaveBeenCalledOnce();
    } finally { ready.open(); hold.resume(); await hold.pending; await operation; await mcp.close(); await closeStrictProof(f); }
  });

});
