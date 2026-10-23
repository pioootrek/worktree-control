import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ControlService } from "@/server/control-service";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { createRemoteVerificationServer, HttpRemoteWorkerTransport } from "./remote-verification-http";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
it("refuses plaintext production origins and listener creation without explicit fixture policy", () => {
  expect(() => new HttpRemoteWorkerTransport("http://worker.invalid", "worker", () => "private")).toThrow("https_required");
  expect(() => new HttpRemoteWorkerTransport("https://user:private@worker.invalid", "worker", () => "private")).toThrow("invalid_remote_origin");
  expect(() => createRemoteVerificationServer({} as Parameters<typeof createRemoteVerificationServer>[0])).toThrow("https_required");
});

it("exposes remote submit/status/log/cancel to an existing scoped MCP conversation using its authenticated actor", async () => {
  const actor: AuthenticatedPrincipal = { principalId: "agent", principalKind: "agent", credentialId: "credential", authenticationMethod: "agent_token" };
  const submitted = vi.fn(() => ({ id: "request" }));
  const status = vi.fn(() => ({ attempt: { id: "attempt" }, result: { logs: ["bounded remote evidence"] } }));
  const cancelled = vi.fn(() => ({ cancellationRequested: true }));
  const service = { remoteVerificationEnabled: () => true, submitRemoteVerification: submitted, getRemoteVerification: status, cancelRemoteVerification: cancelled } as unknown as ControlService;
  const controller = createMcpControllerServer({ service, port: 0, accessToken: "separate-installation-secret", identity: {
    authenticateBearer: () => actor,
    describeIdentity: vi.fn(),
  } });
  await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
  cleanup.push(controller.close);
  const port = (controller.server.address() as { port: number }).port;
  const client = new Client({ name: "isolated-existing-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer scoped-fixture-token" } } }));
  cleanup.push(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(["submit_remote_verification", "get_remote_verification", "get_remote_verification_logs", "cancel_remote_verification"]));
  expect(names).not.toContain("claim_project");
  const input = { projectId: "project", workerId: "worker", commitSha: "a".repeat(40), presetId: "node:test", idempotencyKey: "submit-once" };
  await client.callTool({ name: "submit_remote_verification", arguments: input });
  expect(submitted).toHaveBeenCalledWith(input, actor);
  await client.callTool({ name: "get_remote_verification", arguments: { requestId: "request" } });
  const logs = await client.callTool({ name: "get_remote_verification_logs", arguments: { requestId: "request" } });
  expect(JSON.stringify(logs)).toContain("bounded remote evidence");
  expect(status).toHaveBeenCalledWith("request", actor);
  await client.callTool({ name: "cancel_remote_verification", arguments: { requestId: "request" } });
  expect(cancelled).toHaveBeenCalledWith("request", actor);
});
