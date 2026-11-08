import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import { boundedLogs } from "./scoped-diagnostics";
import { diagnosticsFixture, cleanup } from "./scoped-diagnostics-fixture";
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe("explicit scoped diagnostics", () => {
  it("returns only bounded cached diagnostics and no foreign identity, commands, ENV or directory names", () => {
    const f = diagnosticsFixture();
    const runtime = f.service.scopedRuntimeLogs(f.actor, { projectId: f.project.id });
    expect(runtime.lines).toEqual(["application failure", "Authorization: [redacted]"]);
    expect(f.service.scopedTestLogs(f.actor, { runId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }).lines).toEqual(["test failed", "cookie=[redacted]"]);
    const storage = f.service.scopedProjectStorage(f.actor, { projectId: f.project.id });
    expect(storage.snapshot?.totalBytes).toBe(1234); expect(storage.snapshot?.history.length).toBeLessThanOrEqual(16);
    expect(f.service.scopedServerCapacity(f.actor)).not.toHaveProperty("holders");
    expect(f.service.scopedTestQueue(f.actor)).toMatchObject({ running: 0, queued: 0, admissionAvailable: true });
    const all = JSON.stringify([storage, f.service.scopedServerCapacity(f.actor), f.service.scopedTestQueue(f.actor)]);
    for (const secret of [f.foreign.id, f.foreign.name, "secret-file-name", "PRIVATE_ENV", "secret command", f.issued.token, "agent:mcp:"]) expect(all).not.toContain(secret);
  });
  it.each(["projects:read", "tests:run", "logs:read", "storage:read", "capacity:read"] as RuntimeAction[])("does not infer independent rights from %s", action => {
    const f = diagnosticsFixture([action]);
    const target = { projectId: f.project.id };
    for (const [required, read] of [
      ["logs:read", () => f.service.scopedRuntimeLogs(f.actor, target)],
      ["storage:read", () => f.service.scopedProjectStorage(f.actor, target)],
      ["capacity:read", () => f.service.scopedServerCapacity(f.actor)],
    ] as const) if (action === required) expect(read).not.toThrow(); else expect(read).toThrow();
    expect(() => f.service.scopedTestLogs(f.actor, { runId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" })).toThrow();
  });
  it("keeps old immutable ceilings narrow after delegation gains diagnostic rights", () => {
    const f = diagnosticsFixture(["projects:read"]); f.grant(["projects:read", "logs:read", "storage:read", "capacity:read"]);
    expect(f.service.scopedDiagnosticActions(f.actor)).toEqual(["projects:read"]);
    expect(() => f.service.scopedRuntimeLogs(f.actor, { projectId: f.project.id })).toThrow();
  });
  it("denies another project/run/credential and current revocation, expiry and downgrade", () => {
    const f = diagnosticsFixture();
    expect(() => f.service.scopedRuntimeLogs(f.actor, { projectId: f.foreign.id })).toThrow();
    expect(() => f.service.scopedTestLogs(f.actor, { runId: "missing" })).toThrow();
    expect(() => f.service.scopedTestLogs(f.identity.authenticateBearer(f.issue().token), { runId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" })).toThrow();
    f.onLogs(() => f.identity.revokeCredential(f.issued.credential.id, f.owner));
    expect(() => f.service.scopedRuntimeLogs(f.actor, { projectId: f.project.id })).toThrow();
    const g = diagnosticsFixture(); g.grant(["tests:run"]);
    expect(() => g.service.scopedTestLogs(g.actor, { runId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" })).toThrow();
    const h = diagnosticsFixture(); h.expire(); expect(() => h.service.scopedServerCapacity(h.actor)).toThrow();
  });
  it("bounds lines/encoded bytes and redacts only known controller formats, preserving application text", () => {
    const result = boundedLogs(Array.from({ length: 400 }, () => "failure ".repeat(600)), 100);
    expect(result.truncated).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
    expect(boundedLogs(["unknown-application-secret"], 1).lines).toEqual(["unknown-application-secret"]);
    expect(boundedLogs(['{"cookie":"private-cookie","verifierHash":"private-verifier"}'], 1).lines.join()).not.toMatch(/private-cookie|private-verifier/);
  });
});
