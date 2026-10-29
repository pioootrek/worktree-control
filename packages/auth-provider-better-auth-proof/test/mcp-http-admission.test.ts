import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { ProcessManager } from "@/server/process-manager";
import type { ProofFaultInjection } from "../src/index";
import { request } from "./server-request";
import { cleanupStrictRoots, closeStrictProof, pauseProvisioning, strictProof, type StrictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
function mcpHttp(f: StrictProof) {
  const service = new ControlService(f.store, { list: async () => [] } as never, new ProcessManager());
  return createMcpControllerServer({ service, identity: f.identity, port: 0, accessToken: "fixture-pairing" });
}

describe("strict installed MCP HTTP listener admission", () => {
  it.each(["commit", "rollback"] as const)("returns retryable 503 at initial authentication admission before provider %s", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { admissionTimeoutMs: 80 }), http = mcpHttp(f);
    const authenticate = vi.spyOn(f.identity, "authenticateBearer"), hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused;
      const result = await request(http.server, "/mcp", f.owner.token, input).completed;
      expect(result).toMatchObject({ status: 503, body: { error: { message: "The controller database is unavailable; retry the request." } } });
      expect(result.headers.get("retry-after")).toBe("1");
      expect(authenticate).not.toHaveBeenCalled();
      expect((await http.diagnosticsSnapshot()).logicalSessions).toBe(0);
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });

  it("preserves Retry-After on a 503 from actual MCP HTTP body-read re-admission", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, { admissionTimeoutMs: 80 }), http = mcpHttp(f);
    const authenticate = vi.spyOn(f.identity, "authenticateBearer");
    const call = request(http.server, "/mcp", f.owner.token);
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused; call.send(input);
      const result = await call.completed;
      expect(result.status).toBe(503);
      expect(result.headers.get("retry-after")).toBe("1");
      expect(authenticate).toHaveBeenCalledOnce();
      expect((await http.diagnosticsSnapshot()).logicalSessions).toBe(0);
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });

  it("rechecks queued credential revocation after reading the actual MCP HTTP body", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), http = mcpHttp(f);
    const agent = await f.run(() => f.identity.createAgent(f.ownerActor));
    const issued = await f.run(() => f.identity.issueAgentToken({ principalId: agent.id, label: "MCP HTTP" }, f.ownerActor));
    const authenticate = vi.spyOn(f.identity, "authenticateBearer");
    const call = request(http.server, "/mcp", issued.token);
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = f.run(() => f.identity.revokeCredential(issued.credential.id, f.ownerActor));
      call.send(input);
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(2));
      hold.resume(); await hold.pending; await revoke;
      expect(await call.completed).toMatchObject({ status: 401 });
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect((await http.diagnosticsSnapshot()).logicalSessions).toBe(0);
    } finally { hold.resume(); await hold.pending; await http.close(); await closeStrictProof(f); }
  });
});
