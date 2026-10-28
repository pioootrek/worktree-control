import { describe, expect, it } from "vitest";
import { knowledgePermissions, type KnowledgeRole, type SubjectKind } from "@/shared/contracts/authorization";
import { effectiveKnowledgePermissions, effectiveRuntimeActions, isAuthorized, type RuntimeAuthority } from "./policy";

const subject = { id: "actor", kind: "human" as const, humanSession: true };
const grant = { principalId: "actor", projectId: "p", permissions: [...knowledgePermissions], revokedAt: null };
const binding = { principalId: "actor", projectId: "p", role: "reader" as const, revision: 1, revokedAt: null, updatedAt: "now" };
const context = { grant, binding: null, project: { id: "p", status: "active" as const } };
describe("shared authorization policy", () => {
  it.each<[KnowledgeRole, SubjectKind, string[]]>([
    ["reader", "human", ["knowledge:read", "knowledge:export", "attachments:read"]],
    ["operator", "agent", knowledgePermissions.filter(p => p !== "knowledge:approve")],
    ["manager", "human", [...knowledgePermissions]],
    ["manager", "agent", []],
    ["reader", "worker", []],
  ])("restricts %s for %s", (role, kind, permissions) => {
    expect(effectiveKnowledgePermissions({ ...subject, kind }, "p", { grant, binding: { ...binding, role } })).toEqual(permissions);
  });
  it("never manufactures supplementary permissions or falls back after revocation", () => {
    const read = { ...grant, permissions: ["knowledge:read" as const] };
    expect(effectiveKnowledgePermissions(subject, "p", { grant: read, binding: { ...binding, role: "manager" } })).toEqual(["knowledge:read"]);
    expect(effectiveKnowledgePermissions(subject, "p", { grant, binding: { ...binding, revokedAt: "now" } })).toEqual([]);
    expect(effectiveKnowledgePermissions(subject, "p", { grant: { ...grant, revokedAt: "now" }, binding })).toEqual([]);
    expect(effectiveKnowledgePermissions(subject, "other", { grant, binding })).toEqual([]);
    expect(effectiveKnowledgePermissions({ ...subject, id: "other" }, "p", { grant, binding })).toEqual([]);
    expect(effectiveKnowledgePermissions({ ...subject, humanSession: false }, "p", { grant, binding: null })).not.toContain("knowledge:approve");
  });
  it("denies unknown actions, resource namespace substitution and all ENV actions even for installation authority", () => {
    const installation = { ...subject, kind: "installation" as const };
    expect(isAuthorized(installation, "knowledge:read", { kind: "knowledge-project", id: "p" }, context)).toBe(true);
    for (const kind of ["runtime-project", "dev-vault"] as const) {
      expect(isAuthorized(installation, "knowledge:read", { kind, id: "p" }, context)).toBe(false);
    }
    for (const action of ["env:read", "env:write", "env:use"] as const) {
      expect(isAuthorized(installation, action, { kind: "dev-vault", id: "p" }, context)).toBe(false);
    }
    expect(isAuthorized(installation, "made-up" as never, { kind: "knowledge-project", id: "p" }, context)).toBe(false);
    expect(isAuthorized(subject, "knowledge:write", { kind: "knowledge-project", id: "p" }, { ...context, project: { id: "p", status: "archived" } })).toBe(false);
  });
  it("grants runtime actions only to an agent through both delegation and the exact credential ceiling", () => {
    const agent = { id: "agent", kind: "agent" as const, humanSession: false };
    const runtime: RuntimeAuthority = {
      now: "2026-10-28T12:00:00.000Z", credentialId: "credential", project: { id: "p" },
      delegation: { principalId: "agent", projectId: "p", sponsorId: "owner", actions: ["projects:read", "claims:manage"], revision: 1, expiresAt: null, updatedAt: "now", revokedAt: null },
      scope: { credentialId: "credential", projectId: "p", actions: ["claims:manage", "runtime:control"], createdAt: "now" },
      sponsor: { id: "owner", kind: "human", status: "active" },
    };
    const resource = { kind: "runtime-project" as const, id: "p" };
    expect(effectiveRuntimeActions(agent, "p", runtime)).toEqual(["claims:manage"]);
    expect(isAuthorized(agent, "claims:manage", resource, { ...context, runtime })).toBe(true);
    expect(isAuthorized(agent, "runtime:control", resource, { ...context, runtime })).toBe(false);
    expect(isAuthorized(agent, "knowledge:read", resource, { ...context, runtime })).toBe(false);
    expect(isAuthorized(agent, "claims:manage", { kind: "knowledge-project", id: "p" }, { ...context, runtime })).toBe(false);
    for (const kind of ["human", "worker", "installation"] as const) expect(effectiveRuntimeActions({ ...agent, kind }, "p", runtime)).toEqual([]);
    for (const narrowed of [
      { ...runtime, project: null },
      { ...runtime, credentialId: "other" },
      { ...runtime, scope: { ...runtime.scope!, projectId: "q" } },
      { ...runtime, delegation: { ...runtime.delegation!, revokedAt: "now" } },
      { ...runtime, delegation: { ...runtime.delegation!, expiresAt: runtime.now } },
      { ...runtime, delegation: { ...runtime.delegation!, principalId: "other" } },
      { ...runtime, sponsor: { ...runtime.sponsor!, status: "revoked" as const } },
      { ...runtime, sponsor: { ...runtime.sponsor!, kind: "agent" as const } },
      { ...runtime, sponsor: { ...runtime.sponsor!, id: "someone-else" } },
      { ...runtime, sponsor: null },
    ]) expect(effectiveRuntimeActions(agent, "p", narrowed)).toEqual([]);
    expect(effectiveRuntimeActions(agent, "q", runtime)).toEqual([]);
    expect(isAuthorized(agent, "claims:manage", resource, context)).toBe(false);
  });
});
