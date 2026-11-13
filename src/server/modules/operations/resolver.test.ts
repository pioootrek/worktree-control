import { describe, expect, it } from "vitest";
import { OperationError } from "./errors";
import { InMemoryResolver, P } from "./operations-fixture";
import { resolveAll, sameResolution, type ResourceResolver } from "./resolver";

const projectA = P("project-a");
const projectB = P("project-b");

const reason = (run: () => unknown) => {
  try { run(); return "resolved"; } catch (error) { return error instanceof OperationError ? `${error.category}:${error.reason}` : String(error); }
};

describe("resource resolution", () => {
  it("resolves each kind only in its own namespace", () => {
    const resolver = new InMemoryResolver().addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    expect(resolveAll(resolver, { r: { kind: "registration", id: "reg-1" } }).r.projectId).toBe(projectA);
    // A registration ID that equals a project ID is not a registration.
    expect(reason(() => resolveAll(resolver, { r: { kind: "registration", id: projectA } }))).toBe("not_found:resource_not_found");
    expect(reason(() => resolveAll(resolver, { r: { kind: "project", id: "reg-1" } }))).toBe("not_found:resource_not_found");
    expect(reason(() => resolveAll(resolver, { r: { kind: "vault_entry", id: "reg-1" } }))).toBe("not_found:resource_not_found");
    expect(reason(() => resolveAll(resolver, { r: { kind: "tenant" as never, id: "x" } }))).toBe("invalid_request:unknown_resource_kind");
  });

  it("treats an adapter answer for another namespace or ID as not found, never as a fallback", () => {
    const wrong: ResourceResolver = {
      resolve: ref => ({ ref: { kind: "project", id: ref.id }, projectId: projectA, version: 1, relation: null }),
      listProjects: () => [projectA],
    };
    expect(reason(() => resolveAll(wrong, { r: { kind: "registration", id: "reg-1" } }))).toBe("not_found:resource_not_found");
    const otherId: ResourceResolver = {
      resolve: ref => ({ ref: { kind: ref.kind, id: "something-else" }, projectId: projectA, version: 1, relation: null }),
      listProjects: () => [projectA],
    };
    expect(reason(() => resolveAll(otherId, { r: { kind: "claim", id: "claim-1" } }))).toBe("not_found:resource_not_found");
  });

  it("detects a registration moved between resolution and recheck", () => {
    const resolver = new InMemoryResolver().addProject(projectA).addProject(projectB).put({ kind: "registration", id: "reg-1" }, projectA);
    const refs = { r: { kind: "registration" as const, id: "reg-1" } };
    const before = resolveAll(resolver, refs);
    expect(sameResolution(before, resolveAll(resolver, refs))).toBe(true);
    resolver.move(refs.r, projectB);
    const after = resolveAll(resolver, refs);
    expect(after.r.projectId).toBe(projectB);
    expect(sameResolution(before, after)).toBe(false);
    // Moving back still differs: the relation version changed.
    resolver.move(refs.r, projectA);
    expect(sameResolution(before, resolveAll(resolver, refs))).toBe(false);
    resolver.delete(refs.r);
    expect(reason(() => resolveAll(resolver, refs))).toBe("not_found:resource_not_found");
  });
});
