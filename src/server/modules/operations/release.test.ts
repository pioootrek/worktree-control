import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { ReadOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { pick, releaseError, releaseValue, serializeRelease, MAX_RELEASE_DEPTH, type Page } from "./release";
import { allOf, collection } from "./requirements";
import { OperationRunner, type RunResult } from "./runner";

interface Row { projectId: ProjectId; name: string; secretHolder: string }
interface Input { limit: number; cursor: string | null }

/** Fixture of a multi-project collection query with no project input (like a future project.list). */
interface ListPublic { items: { projectId: ProjectId; name: string }[]; nextCursor: string | null }
const listFixture: ReadOperation<Input, Page<Row>, ListPublic> = {
  id: "fixture.project_list",
  kind: "read",
  requirement: { require: collection("project:read") },
  parse: raw => {
    const value = raw as Partial<Input>;
    return { limit: value.limit ?? 2, cursor: value.cursor ?? null };
  },
  resources: () => ({}),
  read(input, scope) {
    const rows = scope.resolver.listProjects().map(projectId => ({ projectId, name: `name of ${projectId}`, secretHolder: "session-xyz" }));
    return scope.release.page(rows, { projectOf: row => row.projectId, keyOf: row => row.projectId, permission: "project:read", limit: input.limit, cursor: input.cursor });
  },
  publicKeys: ["items", "nextCursor"],
  project: (page) => ({ items: page.items.map(row => pick(row, ["projectId", "name"])), nextCursor: page.nextCursor }),
};

function scenario(hidden: boolean) {
  const world = createWorld();
  const alice = world.human("alice");
  const visible = ["p-02", "p-04", "p-06", "p-08", "p-10"].map(P);
  const invisible = ["p-01", "p-03", "p-05", "p-07", "p-09", "p-11"].map(P);
  for (const id of hidden ? [...visible, ...invisible].sort() : visible) world.resolver.addProject(id);
  for (const id of visible) world.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: id } });
  // A non-reading role on hidden projects must not make them visible.
  if (hidden) for (const id of invisible) world.grants.grant({ accountId: alice.id, role: "secrets", scope: { kind: "project", projectId: id } });
  return { runner: new OperationRunner(world.runtime()), context: alice.context };
}

async function allPages(hidden: boolean, limit: number) {
  const { runner, context } = scenario(hidden);
  const pages: unknown[] = [];
  let cursor: string | null = null;
  do {
    const result: RunResult<ListPublic> = await runner.run(listFixture, context, { limit, cursor });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    pages.push(result.value);
    cursor = result.value.nextCursor;
  } while (cursor);
  return pages;
}

describe("collection release", () => {
  it("filters per item before pagination, so pages and cursors do not depend on invisible items", async () => {
    for (const limit of [1, 2, 3, 5, 100]) {
      const withHidden = await allPages(true, limit);
      const without = await allPages(false, limit);
      expect(withHidden).toEqual(without);
      expect(JSON.stringify(withHidden)).not.toMatch(/p-0[13579]|p-11|session-xyz/);
    }
    const [first] = await allPages(true, 2);
    expect(first).toEqual({ items: [{ projectId: "p-02", name: "name of p-02" }, { projectId: "p-04", name: "name of p-04" }], nextCursor: expect.any(String) });
  });

  it("returns no cursor once the visible items are exhausted, regardless of invisible items after them", async () => {
    const pages = await allPages(true, 5);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ nextCursor: null });
  });

  it("validates limit and cursor", async () => {
    const { runner, context } = scenario(true);
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
      expect(await runner.run(listFixture, context, input)).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "invalid_limit" } });
    }
    expect(await runner.run(listFixture, context, { limit: 2, cursor: "not-a-cursor" })).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "invalid_cursor" } });
  });

  it("lets full authority see every project", async () => {
    const world = createWorld();
    for (const id of ["a", "b", "c"].map(P)) world.resolver.addProject(id);
    const result = await new OperationRunner(world.runtime()).run(listFixture, world.installation().context, { limit: 10 });
    expect(result).toMatchObject({ ok: true, value: { items: [{ projectId: "a" }, { projectId: "b" }, { projectId: "c" }], nextCursor: null } });
  });
});

describe("several collection requirements on one operation", () => {
  it("releases an item only where every collection permission and visibility hold", async () => {
    const world = createWorld();
    const [a, b, c, d] = ["a", "b", "c", "d"].map(P);
    for (const id of [a, b, c, d]) world.resolver.addProject(id);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: a } })
      .grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: b } })
      .grant({ accountId: alice.id, role: "secrets", scope: { kind: "project", projectId: c } });
    const both = { ...listFixture, id: "fixture.project_list_two", requirement: { require: allOf(collection("tests:run"), collection("project:read")) } };
    const runner = new OperationRunner(world.runtime());
    // a: both; b: no tests:run; c: secrets only (invisible); d: nothing.
    expect(await runner.run(both, alice.context, { limit: 10 })).toEqual({ ok: true, replayed: false, value: { items: [{ projectId: "a", name: "name of a" }], nextCursor: null } });
    const secretsOnly = { ...listFixture, read: (input: Input, scope: Parameters<typeof listFixture.read>[1]) =>
      scope.release.page(scope.resolver.listProjects().map(projectId => ({ projectId, name: projectId, secretHolder: "x" })),
        { projectOf: row => row.projectId, keyOf: row => row.projectId, permission: "secrets:read", limit: input.limit, cursor: input.cursor }) };
    // A permission held on an invisible project never releases its items.
    expect(await runner.run(secretsOnly, alice.context, { limit: 10 })).toMatchObject({ ok: true, value: { items: [] } });
    expect(await runner.run(both, world.installation().context, { limit: 10 })).toMatchObject({ ok: true, value: { items: [{ projectId: "a" }, { projectId: "b" }, { projectId: "c" }, { projectId: "d" }] } });
  });
});

describe("strict release serializer", () => {
  const rejected = (value: unknown) => {
    try { serializeRelease(value); return "accepted"; } catch (error) { return (error as { reason?: string }).reason; }
  };

  it("accepts plain data only and returns a fresh copy", () => {
    const source = { a: [1, "two", true, null, { b: -0.5 }], c: Object.assign(Object.create(null), { d: "e" }) as object };
    const copy = serializeRelease(source);
    expect(copy).toEqual({ a: [1, "two", true, null, { b: -0.5 }], c: { d: "e" } });
    expect(copy).not.toBe(source);
    const shared = { x: 1 };
    expect(serializeRelease({ left: shared, right: shared })).toEqual({ left: { x: 1 }, right: { x: 1 } });
  });

  it("rejects toJSON, accessors and anything that is not plain data", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hiddenToJson = Object.defineProperty({ a: 1 }, "toJSON", { enumerable: false, value: () => ({ secret: 1 }) });
    const inheritedToJson = Object.create({ toJSON: () => ({ secret: 1 }) }) as object;
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: () => "secret" });
    const nonEnumerable = Object.defineProperty({}, "a", { enumerable: false, value: "secret" });
    const sparse: unknown[] = [];
    sparse[2] = 3;
    const extra = Object.assign([1], { secret: "x" });
    let deep: unknown = 1;
    for (let index = 0; index <= MAX_RELEASE_DEPTH; index++) deep = [deep];
    for (const value of [
      { toJSON: () => ({}) }, hiddenToJson, inheritedToJson, accessor, nonEnumerable, cycle, sparse, extra, deep,
      { [Symbol("s")]: 1 }, { f: () => 1 }, { n: Number.NaN }, { n: Infinity }, { u: undefined }, { b: BigInt(1) },
      new Date(0), new Map(), new (class Row { a = 1; })(), new Proxy({}, {}), JSON.parse('{"__proto__": {"x": 1}}') as unknown,
      Object.create(Array.prototype) as unknown,
    ]) expect(rejected(value)).toBe("invalid_projection");
  });

  it("rejects a toJSON inherited from a polluted Object.prototype", () => {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, enumerable: false, value: () => ({ secret: 1 }) });
    try {
      expect(rejected({ a: 1 })).toBe("invalid_projection");
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
    expect(rejected({ a: 1 })).toBe("accepted");
  });

  it("checks the allowlist on the serialized value", () => {
    expect(releaseValue({ a: 1 }, ["a"])).toEqual({ a: 1 });
    expect(() => releaseValue({ a: 1, b: 2 }, ["a"])).toThrow(/unlisted_public_field/);
    expect(() => releaseValue([1], ["0"])).toThrow(/invalid_projection/);
  });

  it("releases errors only in the closed public shape", () => {
    expect(releaseError({ category: "conflict", status: 409, reason: "x", retry: "none", effect: "committed" })).toEqual({ category: "conflict", status: 409, reason: "x", retry: "none", effect: "committed" });
    expect(releaseError({ category: "conflict", status: 409, reason: "x", retry: "none", effect: "unknown", detail: "/secret" } as never))
      .toEqual({ category: "outcome_unknown", status: 409, reason: "unexpected_failure", retry: "inspect_first", effect: "unknown" });
    expect(releaseError({ category: "conflict", status: 200, reason: "Localized text", retry: "none", effect: null })).toEqual({ category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null });
  });
});
