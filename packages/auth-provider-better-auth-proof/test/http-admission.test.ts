import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlService } from "@/server/control-service";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { KnowledgeService } from "@/server/modules/knowledge";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, sleep, strictProof, type StrictProof } from "./strict-fixture";

import { request } from "./server-request";

afterEach(cleanupStrictRoots);

function web(f: StrictProof) {
  const knowledge = new KnowledgeService(f.store, f.identity);
  const execute = vi.fn((input: unknown, actor: Parameters<KnowledgeService["execute"]>[1]) => knowledge.execute(input, actor));
  const events = new EventStream(f.store.admission);
  const controller = createControllerServer({ service: { executeKnowledge: execute } as unknown as ControlService,
    identity: f.identity, admission: f.store.admission, directoryBrowser: {} as DirectoryBrowser, events,
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
    webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture-pairing" });
  return { ...controller, execute };
}

describe("strict HTTP admission with a real paused provider", () => {
  it.each(["commit", "rollback"] as const)("waits through provider %s, executes once, and distinguishes invalid credentials and malformed bodies", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), http = web(f);
    const project = await f.run(() => {
      const project = f.identity.createKnowledgeProject({ name: "HTTP fixture" }, f.ownerActor);
      f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }, f.ownerActor);
      return project;
    });
    const body = JSON.stringify({ operation: "create_task", input: { projectId: project.id, title: "Once", description: "boundary", idempotencyKey: "http-once" } });
    const hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused;
      const call = request(http.server, "/api/knowledge", f.owner.token, body);
      await sleep(20);
      expect(call.ended).toBe(false); expect(http.execute).not.toHaveBeenCalled();
      hold.resume(); await hold.pending;
      expect((await call.completed).status).toBe(200);
      expect(http.execute).toHaveBeenCalledOnce();
      expect((await request(http.server, "/api/knowledge", f.owner.token, body).completed).status).toBe(200);
      expect((await f.run(() => f.store.listTasks(project.id, 50, 0))).items).toHaveLength(1);
      expect((await request(http.server, "/api/knowledge", "invalid-fixture", body).completed).status).toBe(401);
      expect(await request(http.server, "/api/knowledge", f.owner.token, "{").completed).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });

  it("checks current credentials when a request enters after a queued revocation", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), http = web(f);
    const agent = await f.run(() => f.identity.createAgent(f.ownerActor));
    const credential = await f.run(() => f.identity.issueAgentToken({ principalId: agent.id, label: "HTTP fixture" }, f.ownerActor));
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = f.run(() => f.identity.revokeCredential(credential.credential.id, f.ownerActor));
      const call = request(http.server, "/api/knowledge", credential.token, JSON.stringify({ operation: "projects", input: {} }));
      hold.resume(); await hold.pending; await revoke;
      expect(await call.completed).toMatchObject({ status: 401, body: { code: "invalid_credential" } });
      expect(http.execute).not.toHaveBeenCalled();
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });

  it("returns safe 503 when initial admission expires without executing the handler", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { admissionTimeoutMs: 80 }), http = web(f);
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const result = await request(http.server, "/api/knowledge", f.owner.token, "{}").completed;
      expect(result).toMatchObject({ status: 503, body: { code: "database_busy", error: "database_busy" } });
      expect(result.headers.get("retry-after")).toBe("1"); expect(http.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(result.body)).not.toContain(f.owner.token);
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });

  it.each(["/api/knowledge", "/api/dev-vault"])("preserves the 503 classification when %s body-read re-admission times out", async path => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { admissionTimeoutMs: 80 }), http = web(f);
    // The real handler enters, authenticates where applicable, and idles waiting for body bytes.
    const call = request(http.server, path, f.owner.token);
    await vi.waitFor(() => expect(f.store.admissionSnapshot().coreActive).toBe(0));
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused; call.send("{}");
      const result = await call.completed;
      expect.soft(result.status).toBe(503);
      expect.soft(result.body.code).toBe("database_busy");
      expect.soft(result.headers.get("retry-after")).toBe("1");
      expect(http.execute).not.toHaveBeenCalled();
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });
});
