import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import type { ReadOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { pick, type Page } from "./release";
import { collection } from "./requirements";
import { OperationRunner } from "./runner";

interface Row { projectId: ProjectId; name: string; secretHolder: string }
interface Input { limit: number; cursor: string | null }

/** Fixture of a multi-project collection query with no project input (like a future project.list). */
const listFixture: ReadOperation<Input, Page<Row>, { items: { projectId: ProjectId; name: string }[]; nextCursor: string | null }> = {
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
    const result = await runner.run(listFixture, context, { limit, cursor });
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
