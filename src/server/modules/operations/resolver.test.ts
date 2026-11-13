import { describe, expect, it } from "vitest";
import { OperationError } from "./errors";
import { InMemoryResolver, P } from "./operations-fixture";
import { copyResolution, resolveAll, sameResolution, type ResourceResolver } from "./resolver";
import type { ResolvedResources } from "./requirements";

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

describe("resource slots (decision Q)", () => {
  const resolver = () => new InMemoryResolver().addProject(projectA).addProject(projectB)
    .put({ kind: "registration", id: "reg-a" }, projectA).put({ kind: "registration", id: "reg-b" }, projectB);

  it("rejects a __proto__ slot, a prototype smuggled by a literal and any other invalid name", () => {
    const ref = { kind: "registration" as const, id: "reg-b" };
    const computed = { ["__proto__"]: ref, a: { kind: "registration" as const, id: "reg-a" } };
    expect(Object.keys(computed)).toContain("__proto__");
    const literal = { __proto__: ref, a: { kind: "registration" as const, id: "reg-a" } };
    for (const refs of [computed, literal, { "": ref }, { "1slot": ref }, { "bad-slot": ref }, { _hidden: ref }, { [Symbol("s")]: ref }]) {
      expect(reason(() => resolveAll(resolver(), refs as never))).toBe("internal:invalid_resource_slot");
    }
  });

  it("returns a frozen null-prototype record", () => {
    const resolved = resolveAll(resolver(), { a: { kind: "registration", id: "reg-a" } });
    expect(Object.getPrototypeOf(resolved)).toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.a)).toBe(true);
  });

  it("compares every slot, whatever its name, and copies stored records strictly", () => {
    const before = resolveAll(resolver(), { a: { kind: "registration", id: "reg-a" } });
    const extra = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(extra, "a", { value: before.a, enumerable: true });
    Object.defineProperty(extra, "__proto__", { value: before.a, enumerable: true });
    expect(sameResolution(before, extra as ResolvedResources)).toBe(false);
    expect(sameResolution(extra as ResolvedResources, before)).toBe(false);
    expect(sameResolution(before, resolveAll(resolver(), { a: { kind: "registration", id: "reg-a" } }))).toBe(true);
    expect(copyResolution(structuredClone(before))).toEqual(before);
    expect(copyResolution(extra)).toBeNull();
    expect(copyResolution({ a: { ...before.a, projectId: 5 } })).toBeNull();
  });
});

describe("three passes over references (decision X)", () => {
  const malformed = { kind: "tenant", id: "x" } as never;
  const missing = { kind: "registration" as const, id: "reg-missing" };
  const existing = { kind: "registration" as const, id: "reg-b" };
  const world = () => new InMemoryResolver().addProject(projectA).addProject(projectB)
    .put({ kind: "registration", id: "reg-a" }, projectA).put(existing, projectB);
  /** Every arrangement of two references: both slot assignments and both key insertion orders. */
  const arrangements = (left: unknown, right: unknown) => [
    { first: left, second: right }, { second: right, first: left },
    { first: right, second: left }, { second: left, first: right },
  ] as never[];

  it("rejects a malformed reference before any lookup, whether the other one exists or not", () => {
    for (const other of [missing, existing]) {
      for (const refs of arrangements(malformed, other)) {
        const resolver = world();
        expect(reason(() => resolveAll(resolver, refs))).toBe("invalid_request:unknown_resource_kind");
        expect(resolver.resolveCalls).toBe(0);
      }
    }
  });

  it("reports one syntax reason for several malformed references, whatever their order", () => {
    const badId = { kind: "registration", id: "" } as never;
    for (const refs of arrangements(badId, malformed)) expect(reason(() => resolveAll(world(), refs))).toBe("invalid_request:unknown_resource_kind");
    for (const refs of arrangements(badId, null)) expect(reason(() => resolveAll(world(), refs))).toBe("invalid_request:invalid_resource_reference");
  });

  it("resolves every reference before answering not_found, in every order", () => {
    for (const other of [missing, existing, { kind: "registration" as const, id: "reg-a" }]) {
      for (const refs of arrangements(missing, other)) {
        const resolver = world();
        expect(reason(() => resolveAll(resolver, refs))).toBe("not_found:resource_not_found");
        expect(resolver.resolveCalls).toBe(2);
      }
    }
  });

  it("lets a failing lookup win over a miss, whatever the order, without hiding it as not_found", () => {
    for (const other of [missing, existing]) {
      for (const failure of ["throws", "thenable"] as const) {
        for (const refs of arrangements({ kind: "registration", id: "reg-boom" }, other)) {
          const resolver = world();
          const resolve = resolver.resolve.bind(resolver);
          resolver.resolve = ref => {
            if (ref.id !== "reg-boom") return resolve(ref);
            if (failure === "throws") throw new Error("lookup failed /secret");
            return Promise.reject(new Error("late /secret")) as never;
          };
          const answer = reason(() => resolveAll(resolver, refs));
          expect(answer).toBe(failure === "throws" ? "Error: lookup failed /secret" : "internal:resolver_not_synchronous");
          expect(resolver.resolveCalls).toBe(1);
        }
      }
    }
  });
});
