import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessManager } from "@/server/process-manager";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { AccountGrantsQueries } from "@/server/infrastructure/sqlite/account-grants-queries";
import { ProjectDirectoryQueries } from "@/server/infrastructure/sqlite/project-directory-queries";
import { GitCommandCapacityError } from "@/server/git-worktrees";
import { CoalescingWorktreeDiscovery, WORKTREE_DISCOVERY_LIMITS, type WorktreeGit } from "./adapters/worktree-discovery";
import { sqliteGrants } from "./adapters/sqlite-grants";
import { SqliteResourceResolver } from "./adapters/sqlite-resolver";
import type { AuthenticationContext } from "./authentication-context";
import { OperationRegistry, type Operation } from "./operation";
import type { ProjectListResult } from "@/shared/contracts/operations";
import { createWorld } from "./operations-fixture";
import { createProjectReads, MAX_PROJECT_REGISTRATIONS, MAX_PROJECT_WORKTREES, PROJECT_WORKTREES_TIMEOUT_MS } from "./project-reads";
import { OperationRunner, type RunResult } from "./runner";

/**
 * D2a: the three project reads through the real runner, over a real store,
 * the SQLite grants and resolver adapters and the coalescing discovery. Only
 * credentials are fixtures; projects, registrations, claims and grants are
 * SQLite rows written through the store's own paths.
 */
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const AT = "2026-11-16T00:00:00.000Z";
let ports = 7100;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reparent(database: Database.Database, registration: string, parent: string | null): void {
  database.transaction(() => {
    database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    database.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, registration);
  })();
}

function fixture(processes?: ProcessManager) {
  const root = mkdtempSync(join(tmpdir(), "project-reads-")); roots.push(root);
  const store = new SqliteStateStore(join(root, "state.sqlite"));
  closers.push(() => store.close());
  const database = ownedFixtureDatabase(store);
  const world = createWorld();
  const tree = (path: string, branch: string) => ({ path, branch, head: "a".repeat(40), shortHead: "aaaaaaaa", detached: false, locked: false, prunable: false, dirty: true,
    // Fields outside the allowlist that the Git reader really returns; they must never be released.
    statusError: "private Git error text", lastCommitAt: AT, merged: false, mergedInto: "main", isDefaultBranch: false });
  const gates = new Map<string, ReturnType<typeof deferred<unknown[]>>>();
  const git = {
    listTrees: vi.fn((path: string): Promise<unknown[]> => {
      const gate = gates.get(path);
      if (gate) return gate.promise;
      if (path.endsWith("broken")) return Promise.reject(new Error("fatal: private path /secret"));
      return Promise.resolve([tree(path, "main"), tree(`${path}-feature`, "feature")]);
    }),
    worktreeDirty: vi.fn(async (_path: string) => true),
  };
  const discovery = new CoalescingWorktreeDiscovery(git);
  const placement = processes ?? { statusSummary: vi.fn((id: string) => id === ids.alpha
    ? { phase: "running", worktreePath: "/code/alpha-feature", startedAt: AT } : { phase: "stopped", worktreePath: null, startedAt: null }) };
  const reads = createProjectReads({ catalog: store.projectCatalogReader(), placement, discovery });
  const registry = new OperationRegistry();
  const list = registry.register(reads.list), status = registry.register(reads.status), worktrees = registry.register(reads.worktrees);
  const runner = new OperationRunner({ ...world.runtime(), grants: sqliteGrants(new AccountGrantsQueries(database)),
    resolver: new SqliteResourceResolver(new ProjectDirectoryQueries(database)) });

  const project = (id: string, status: "active" | "archived" = "active") =>
    store.saveKnowledgeProject({ id, name: `Name ${id}`, status, revision: 1, createdAt: AT, updatedAt: AT }, "fixture");
  const register = (name: string, parent: string | null, repositoryPath = `/code/${name}`) => {
    const id = store.addProject({ name, repositoryPath, port: ports++, executable: "node", args: ["--secret-flag", name] }).id;
    reparent(database, id, parent);
    return id;
  };
  for (const id of ["project-a", "project-b", "project-empty"]) project(id);
  project("project-archived", "archived");
  const ids = {
    alpha: register("alpha", "project-a"), alpha2: register("alpha2", "project-a"), beta: register("beta", "project-b"),
    archived: register("old", "project-archived"), parentless: register("loose", null), broken: register("broken", "project-b", "/code/broken"),
  };
  store.saveRemotePrincipal({ id: "agent-holder", kind: "agent", status: "active" }, "fixture");
  store.acquireReservation({ projectId: ids.alpha, worktreePath: "/code/alpha", kind: "human", owner: "local-user", reason: "private holder reason" });
  database.prepare("UPDATE reservations SET principal_id='agent-holder' WHERE project_id=?").run(ids.alpha);

  const grant = (account: string, role: string, projectId: string | null) => database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)")
    .run(account, role, projectId === null ? "installation" : "project", projectId, AT);
  const revoke = (account: string) => database.prepare("DELETE FROM account_grants WHERE account_id=?").run(account);
  const agent = (name: string, role?: string, projectId: string | null = "project-a") => {
    store.saveRemotePrincipal({ id: name, kind: "agent", status: "active" }, "fixture");
    if (role) grant(name, role, projectId);
    return world.agent(name).context;
  };
  const human = (name: string, role?: string, projectId: string | null = "project-a") => {
    store.humanAccounts().createHumanPrincipal({ id: name, kind: "human", status: "active" }, "fixture");
    if (role) grant(name, role, projectId);
    return world.human(name).context;
  };
  return { store, database, world, git, gates, tree, discovery, placement, registry, runner, list, status, worktrees, ids, agent, human, grant, revoke, reparent: (id: string, to: string | null) => reparent(database, id, to) };
}
type Fixture = ReturnType<typeof fixture>;
const notFound = { ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } };

describe("project reads (D2a)", () => {
  it("gives a zero-role account an empty list and the missing-resource answer for every project, existing or not", async () => {
    const f = fixture(), zero = f.agent("zero");
    expect(await f.runner.run(f.list, zero, {})).toEqual({ ok: true, replayed: false, value: { items: [], nextCursor: null } });
    for (const projectId of ["project-a", "project-archived", "does-not-exist"]) {
      expect(await f.runner.run(f.status, zero, { projectId })).toEqual(notFound);
      expect(await f.runner.run(f.worktrees, zero, { projectId })).toEqual(notFound);
    }
    expect(f.git.listTrees).not.toHaveBeenCalled();
  });

  it("reads runtime summaries only for registrations on the visible page", async () => {
    const processes = new ProcessManager();
    const summaries = vi.spyOn(processes, "statusSummary");
    const snapshots = vi.spyOn(processes, "snapshot");
    const f = fixture(processes);
    expect(await f.runner.run(f.list, f.agent("zero"), {})).toMatchObject({ ok: true, value: { items: [] } });
    expect(summaries).not.toHaveBeenCalled();

    const reader = f.agent("reader", "reader", "project-a");
    f.grant("reader", "reader", "project-b");
    expect(await f.runner.run(f.list, reader, { limit: 1 })).toMatchObject({
      ok: true, value: { items: [{ projectId: "project-a" }], nextCursor: expect.any(String) },
    });
    expect(summaries.mock.calls.map(([id]) => id)).toEqual([f.ids.alpha, f.ids.alpha2].sort());
    expect(snapshots).not.toHaveBeenCalled();
  });

  it("reports the selected worktree for a stopped or failed runtime, never the path it last ran", async () => {
    const f = fixture(), installation = f.world.installation("api").context;
    f.store.setSelectedWorktree(f.ids.alpha2, "/code/alpha2-selected");
    const summaries = f.placement.statusSummary as unknown as ReturnType<typeof vi.fn>;
    for (const phase of ["stopped", "failed"] as const) {
      // An explicit start on a non-selected worktree, then a stop: the runtime keeps its last path.
      summaries.mockImplementation((id: string) => id === f.ids.alpha2
        ? { phase, worktreePath: "/code/alpha2-explicit", startedAt: null } : { phase: "stopped", worktreePath: null, startedAt: null });
      const listed = await f.runner.run(f.list, installation, {});
      if (!listed.ok) throw new Error(listed.error.reason);
      const entry = listed.value.items.flatMap(item => item.registrations).find(registration => registration.registrationId === f.ids.alpha2);
      expect([phase, entry?.worktreePath]).toEqual([phase, "/code/alpha2-selected"]);
      const compact = await f.runner.run(f.status, installation, { projectId: "project-a", compact: true });
      if (!compact.ok) throw new Error(compact.error.reason);
      expect(compact.value.registrations.find(registration => registration.registrationId === f.ids.alpha2)?.worktreePath).toBe("/code/alpha2-selected");
    }
    // A live runtime still reports the worktree it runs.
    summaries.mockImplementation((id: string) => id === f.ids.alpha2
      ? { phase: "running", worktreePath: "/code/alpha2-explicit", startedAt: AT } : { phase: "stopped", worktreePath: null, startedAt: null });
    const running = await f.runner.run(f.list, installation, {});
    if (!running.ok) throw new Error(running.error.reason);
    expect(running.value.items.flatMap(item => item.registrations).find(registration => registration.registrationId === f.ids.alpha2)?.worktreePath).toBe("/code/alpha2-explicit");
  });

  it("filters before pagination: a reader sees only its project, with no cursor betraying hidden ones", async () => {
    const f = fixture(), reader = f.agent("reader", "reader");
    const listed = await f.runner.run(f.list, reader, { limit: 1 });
    expect(listed).toEqual({ ok: true, replayed: false, value: { nextCursor: null, items: [{
      projectId: "project-a", name: "Name project-a", status: "active", registrationsTruncated: false,
      registrations: [
        { registrationId: f.ids.alpha, name: "alpha", port: expect.any(Number), phase: "running", worktreePath: "/code/alpha-feature", claim: "other" },
        { registrationId: f.ids.alpha2, name: "alpha2", port: expect.any(Number), phase: "stopped", worktreePath: null, claim: "none" },
      ].sort((l, r) => (l.registrationId < r.registrationId ? -1 : 1)),
    }] } });
    // A hidden project answers exactly like a missing one.
    expect(await f.runner.run(f.status, reader, { projectId: "project-b" })).toEqual(await f.runner.run(f.status, reader, { projectId: "nope" }));
  });

  it("pages an admin through every project, never through a parentless registration", async () => {
    const f = fixture(), admin = f.human("admin", "admin", null);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: RunResult<ProjectListResult> = await f.runner.run(f.list, admin, { limit: 2, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.error.reason);
      seen.push(...page.value.items.map(item => item.projectId));
      cursor = page.value.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["project-a", "project-archived", "project-b", "project-empty"]);
  });

  it("lists archived, empty and parentless entries to full authority on every full-authority listener", async () => {
    const f = fixture();
    for (const context of [f.world.installation("api").context, f.world.installation("mcp").context, f.world.operator()]) {
      const listed = await f.runner.run(f.list, context, {});
      if (!listed.ok) throw new Error(listed.error.reason);
      const items = listed.value.items;
      expect(items.map(item => [item.projectId, item.status, item.registrations.map(r => r.registrationId)])).toEqual([
        ["project-a", "active", [f.ids.alpha, f.ids.alpha2].sort()],
        ["project-archived", "archived", [f.ids.archived]],
        ["project-b", "active", [f.ids.beta, f.ids.broken].sort()],
        ["project-empty", "active", []],
        [null, null, [f.ids.parentless]],
      ]);
      expect(items[4].name).toBe("loose");
    }
  });

  it("projects status by permission: launch only with config:read, the holder only with claims:manage, writable with knowledge:write", async () => {
    const f = fixture();
    const reader = await f.runner.run(f.status, f.agent("reader", "reader"), { projectId: "project-a" });
    const maintainer = await f.runner.run(f.status, f.human("maint", "maintainer"), { projectId: "project-a" });
    const operator = await f.runner.run(f.status, f.agent("op", "operator"), { projectId: "project-a" });
    if (!reader.ok || !maintainer.ok || !operator.ok) throw new Error("expected success");
    const alpha = (value: typeof reader.value) => value.registrations.find(r => r.registrationId === f.ids.alpha) as unknown as Record<string, unknown>;
    // Reader holds config:read but not claims:manage or knowledge:write.
    expect(reader.value).toMatchObject({ projectId: "project-a", status: "active", revision: 1, writable: false, compact: false });
    expect(alpha(reader.value).launch).toEqual({ executable: "node", args: ["--secret-flag", "alpha"] });
    expect(alpha(reader.value)).not.toHaveProperty("claimHolder");
    expect(operator.value.writable).toBe(true);
    // Holder identity only: never the claim's reason, owner string or times.
    expect(alpha(operator.value).claimHolder).toEqual({ kind: "human", accountId: "agent-holder" });
    expect(JSON.stringify(operator.value)).not.toMatch(/private holder reason|expiresAt|createdAt/);
    expect(alpha(maintainer.value)).toMatchObject({ claim: "other", selectedWorktreePath: null, startedAt: AT, managedServer: true, phase: "running" });
    // The serialized DTO carries no owner string, token hash or credential.
    expect(JSON.stringify(maintainer.value)).not.toMatch(/local-user|token_hash|credential/);
  });

  it("withholds launch and holder from a status holder without config:read, and compact releases summaries only", async () => {
    const f = fixture();
    const secrets = f.agent("secrets-only", "secrets");
    // Visible through `secrets`, but without project:read: forbidden, not hidden.
    expect(await f.runner.run(f.status, secrets, { projectId: "project-a" })).toMatchObject({ ok: false, error: { category: "forbidden", reason: "permission_denied" } });
    expect(await f.runner.run(f.list, secrets, {})).toMatchObject({ ok: true, value: { items: [] } });
    const compact = await f.runner.run(f.status, f.human("maint", "maintainer"), { projectId: "project-a", compact: true });
    if (!compact.ok) throw new Error(compact.error.reason);
    expect(compact.value.compact).toBe(true);
    for (const entry of compact.value.registrations) expect(Object.keys(entry).sort()).toEqual(["claim", "name", "phase", "port", "registrationId", "worktreePath"]);
  });

  it("validates input with the operation's own parse on every call", async () => {
    const f = fixture(), context = f.world.installation("api").context;
    for (const [operation, input, reason] of [
      [f.list, { limit: 0 }, "invalid_limit"], [f.list, { limit: 101 }, "invalid_limit"], [f.list, { cursor: "" }, "invalid_cursor"], [f.list, { extra: 1 }, "unexpected_input"],
      [f.list, { cursor: "not-a-cursor" }, "invalid_cursor"], [f.status, {}, "invalid_project_id"], [f.status, { projectId: "a b" }, "invalid_project_id"],
      [f.status, { projectId: "project-a", compact: "yes" }, "invalid_input"], [f.worktrees, { projectId: "project-a", extra: true }, "unexpected_input"],
    ] as const) {
      expect(await f.runner.run(operation as unknown as Operation<unknown, unknown, object>, context, input), JSON.stringify(input)).toMatchObject({ ok: false, error: { category: "invalid_request", reason } });
    }
  });

  it("is never registered on the worker listener", async () => {
    const f = fixture();
    expect(f.registry.idsOn("worker")).toEqual([]);
    expect(f.registry.idsOn("api")).toEqual(["project.list", "project.status", "project.worktrees"]);
    for (const [operation, input] of [[f.list, {}], [f.status, { projectId: "project-a" }], [f.worktrees, { projectId: "project-a" }]] as const) {
      expect(await f.runner.run(operation as unknown as Operation<unknown, unknown, object>, f.world.installation("worker").context, input))
        .toMatchObject({ ok: false, error: { category: "not_found", reason: "operation_not_registered" } });
    }
    expect(f.git.listTrees).not.toHaveBeenCalled();
  });

  it("releases only allowlisted worktree fields and reports a failed discovery without its cause", async () => {
    const f = fixture();
    const found = await f.runner.run(f.worktrees, f.agent("reader", "reader", "project-b"), { projectId: "project-b" });
    if (!found.ok) throw new Error(found.error.reason);
    const byId = Object.fromEntries(found.value.registrations.map(entry => [entry.registrationId, entry]));
    expect(byId[f.ids.beta]).toEqual({ registrationId: f.ids.beta, discovery: "complete", worktreesTruncated: false, worktrees: [
      { path: "/code/beta", branch: "main", head: "a".repeat(40), shortHead: "aaaaaaaa", detached: false, locked: false, prunable: false, dirty: true },
      { path: "/code/beta-feature", branch: "feature", head: "a".repeat(40), shortHead: "aaaaaaaa", detached: false, locked: false, prunable: false, dirty: true },
    ] });
    expect(byId[f.ids.broken]).toEqual({ registrationId: f.ids.broken, discovery: "unavailable", worktrees: [], worktreesTruncated: false });
    expect(JSON.stringify(found.value)).not.toMatch(/statusError|private|lastCommitAt|mergedInto/);
  });

  it("coalesces concurrent discovery of one repository and discovers again on the next call", async () => {
    const f = fixture(), gate = deferred<unknown[]>();
    f.gates.set("/code/beta", gate);
    const context = f.world.installation("api").context;
    const first = f.runner.run(f.worktrees, context, { projectId: "project-b" }), second = f.runner.run(f.worktrees, context, { projectId: "project-b" });
    await vi.waitFor(() => expect(f.discovery.inFlight).toBe(1));
    gate.resolve([f.tree("/code/beta", "main")]);
    expect((await first).ok && (await second).ok).toBe(true);
    expect(f.git.listTrees.mock.calls.filter(([path]) => path === "/code/beta")).toHaveLength(1);
    f.gates.delete("/code/beta");
    await f.runner.run(f.worktrees, context, { projectId: "project-b" });
    expect(f.git.listTrees.mock.calls.filter(([path]) => path === "/code/beta")).toHaveLength(2);
  });

  it("releases nothing when authority is revoked while discovery waits", async () => {
    const f = fixture(), gate = deferred<unknown[]>();
    f.gates.set("/code/beta", gate);
    const reader = f.agent("reader", "reader", "project-b");
    const pending = f.runner.run(f.worktrees, reader, { projectId: "project-b" });
    await vi.waitFor(() => expect(f.discovery.inFlight).toBe(1));
    f.revoke("reader");
    gate.resolve([f.tree("/code/beta", "main")]);
    expect(await pending).toEqual(notFound);
  });

  it("refuses a registration moved or repointed while discovery waits", async () => {
    const f = fixture(), gate = deferred<unknown[]>();
    f.gates.set("/code/beta", gate);
    const context = f.world.installation("api").context;
    const pending = f.runner.run(f.worktrees, context, { projectId: "project-b" });
    await vi.waitFor(() => expect(f.discovery.inFlight).toBe(1));
    // The project slot itself is unchanged: only the registration check catches the move.
    f.reparent(f.ids.beta, "project-a");
    gate.resolve([f.tree("/code/beta", "main")]);
    expect(await pending).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed" } });
  });

  it("cancels one waiter without cancelling the shared discovery of another", async () => {
    const f = fixture(), gate = deferred<unknown[]>();
    f.gates.set("/code/beta", gate);
    const context = f.world.installation("api").context, abort = new AbortController();
    const cancelled = f.runner.run(f.worktrees, context, { projectId: "project-b" }, { signal: abort.signal });
    const kept = f.runner.run(f.worktrees, context, { projectId: "project-b" });
    await vi.waitFor(() => expect(f.discovery.inFlight).toBe(1));
    abort.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { category: "unavailable", reason: "request_cancelled", retry: "retry" } });
    gate.resolve([f.tree("/code/beta", "main")]);
    expect(await kept).toMatchObject({ ok: true });
    expect(f.git.listTrees.mock.calls.filter(([path]) => path === "/code/beta")).toHaveLength(1);
  });

  it("bounds registrations per project and refuses discovery beyond the in-flight bound", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_PROJECT_REGISTRATIONS + 1; i++) {
      const id = f.store.addProject({ name: `many-${i}`, repositoryPath: `/code/many-${i}`, port: ports++, executable: "node", args: [] }).id;
      f.reparent(id, "project-empty");
    }
    const status = await f.runner.run(f.status, f.world.installation("api").context, { projectId: "project-empty" });
    expect(status.ok && [status.value.registrations.length, status.value.registrationsTruncated]).toEqual([MAX_PROJECT_REGISTRATIONS, true]);
  });

  it("spends one budget of status reads across the project's registrations, after listing all of them", async () => {
    const f = fixture();
    const many = (path: string, count: number) => Array.from({ length: count }, (_, i) => f.tree(`${path}/t${String(i).padStart(2, "0")}`, `b${i}`));
    f.gates.set("/code/alpha", { ...deferred<unknown[]>(), promise: Promise.resolve(many("/code/alpha", 40)) });
    f.gates.set("/code/alpha2", { ...deferred<unknown[]>(), promise: Promise.resolve(many("/code/alpha2", 40)) });
    const order: string[] = [];
    f.git.listTrees.mockImplementation(async (path: string) => { order.push(`list ${path}`); return f.gates.get(path)!.promise; });
    f.git.worktreeDirty.mockImplementation(async (path: string) => { order.push(`status ${path}`); return false; });
    const found = await f.runner.run(f.worktrees, f.world.installation("api").context, { projectId: "project-a" });
    if (!found.ok) throw new Error(found.error.reason);
    // Every listing came before the first status read, and only the budget was read.
    expect(order.slice(0, 2).sort()).toEqual(["list /code/alpha", "list /code/alpha2"]);
    expect(f.git.worktreeDirty).toHaveBeenCalledTimes(MAX_PROJECT_WORKTREES);
    // The budget goes in registration order: the first keeps all 40 trees, the second the rest.
    const [first, second] = found.value.registrations;
    expect([first.worktrees.length, first.worktreesTruncated, first.discovery]).toEqual([40, false, "complete"]);
    expect([second.worktrees.length, second.worktreesTruncated, second.discovery]).toEqual([MAX_PROJECT_WORKTREES - 40, true, "complete"]);
    // Exactly the released trees were read, nothing past the budget.
    expect(new Set(f.git.worktreeDirty.mock.calls.map(([path]) => path))).toEqual(new Set(found.value.registrations.flatMap(entry => entry.worktrees.map(tree => tree.path))));
  });
});

describe("CoalescingWorktreeDiscovery (D2a)", () => {
  const fact = (path: string) => ({ path, branch: "main", head: "c".repeat(40), shortHead: "cccccccc", detached: false, locked: false, prunable: false });
  function git() {
    const signals = new Map<string, AbortSignal>();
    const listTrees = vi.fn(async (path: string, options: { signal: AbortSignal }): Promise<unknown[]> => { signals.set(`list ${path}`, options.signal); return [fact(`${path}/main`), fact(`${path}/b`)]; });
    const worktreeDirty = vi.fn(async (path: string, options: { signal: AbortSignal }) => { signals.set(`status ${path}`, options.signal); return path.endsWith("/b"); });
    return { listTrees, worktreeDirty, signals } satisfies WorktreeGit & { signals: Map<string, AbortSignal> };
  }
  const never = <T>() => new Promise<T>(() => undefined);

  it("reports status failures as partial with dirty null and failed listings as unavailable, without causes", async () => {
    const reader = git();
    reader.listTrees.mockImplementation(async (path: string) => { if (path === "/gone") throw new Error("fatal: /secret"); return [fact(`${path}/main`), fact(`${path}/b`)]; });
    reader.worktreeDirty.mockImplementation(async (path: string) => { if (path === "/r/b") throw new Error("private"); return false; });
    const found = await new CoalescingWorktreeDiscovery(reader).discover(["/r", "/gone"], 64, new AbortController().signal);
    expect(found).toEqual([
      { state: "partial", truncated: false, worktrees: [{ ...fact("/r/main"), dirty: false }, { ...fact("/r/b"), dirty: null }] },
      { state: "unavailable" },
    ]);
  });

  it("refuses a call beyond the listing or status bound before starting anything new", async () => {
    const reader = git(), signal = new AbortController().signal;
    reader.listTrees.mockImplementation(() => never());
    const listings = new CoalescingWorktreeDiscovery(reader, { maxRepositories: 1 });
    void listings.discover(["/one"], 64, signal).catch(() => undefined);
    await expect(listings.discover(["/two"], 64, signal)).rejects.toMatchObject({ category: "busy", reason: "discovery_capacity", retry: "retry" });
    expect(reader.listTrees.mock.calls.map(([path]) => path)).toEqual(["/one"]);

    const slow = git();
    slow.worktreeDirty.mockImplementation(() => never());
    const statuses = new CoalescingWorktreeDiscovery(slow, { maxStatuses: 2 });
    void statuses.discover(["/one"], 64, signal).catch(() => undefined);
    await vi.waitFor(() => expect(statuses.statusesInFlight).toBe(2));
    await expect(statuses.discover(["/two"], 64, signal)).rejects.toMatchObject({ category: "busy", reason: "discovery_capacity" });
    expect(slow.worktreeDirty).toHaveBeenCalledTimes(2);
  });

  it("answers Git admission capacity as busy, never as a failed discovery", async () => {
    const reader = git();
    reader.listTrees.mockRejectedValue(new GitCommandCapacityError());
    await expect(new CoalescingWorktreeDiscovery(reader).discover(["/r"], 64, new AbortController().signal))
      .rejects.toMatchObject({ category: "busy", reason: "discovery_capacity", retry: "retry" });
    const statuses = git();
    statuses.worktreeDirty.mockRejectedValue(new GitCommandCapacityError());
    await expect(new CoalescingWorktreeDiscovery(statuses).discover(["/r"], 64, new AbortController().signal))
      .rejects.toMatchObject({ category: "busy", reason: "discovery_capacity" });
  });

  it("shares listings and status reads in flight, and aborts a shared read only when its last caller leaves", async () => {
    const reader = git(), gate = deferred<unknown[]>();
    reader.listTrees.mockImplementation(async (path: string, options: { signal: AbortSignal }) => { reader.signals.set(`list ${path}`, options.signal); return gate.promise; });
    const discovery = new CoalescingWorktreeDiscovery(reader);
    const first = new AbortController(), second = new AbortController();
    const left = discovery.discover(["/r"], 64, first.signal), kept = discovery.discover(["/r"], 64, second.signal);
    await vi.waitFor(() => expect(discovery.inFlight).toBe(1));
    first.abort();
    await expect(left).rejects.toMatchObject({ category: "unavailable", reason: "request_cancelled" });
    expect(reader.signals.get("list /r")!.aborted).toBe(false);
    gate.resolve([fact("/r/main"), fact("/r/b")]);
    expect(await kept).toEqual([{ state: "complete", truncated: false, worktrees: [{ ...fact("/r/main"), dirty: false }, { ...fact("/r/b"), dirty: true }] }]);
    expect(reader.listTrees).toHaveBeenCalledTimes(1);
    expect([discovery.inFlight, discovery.statusesInFlight]).toEqual([0, 0]);

    // Two calls reaching the same status reads share them.
    const statusGate = deferred<boolean>();
    reader.worktreeDirty.mockImplementation(() => statusGate.promise);
    const a = discovery.discover(["/s"], 64, new AbortController().signal), b = discovery.discover(["/s"], 64, new AbortController().signal);
    await vi.waitFor(() => expect(discovery.statusesInFlight).toBe(2));
    statusGate.resolve(false);
    expect((await a)[0]).toEqual((await b)[0]);
    expect(reader.worktreeDirty).toHaveBeenCalledTimes(2 + 2);

    // The only caller leaving aborts the Git read, and the next call starts a new one.
    reader.listTrees.mockImplementation(async (path: string, options: { signal: AbortSignal }) => { reader.signals.set(`list ${path}`, options.signal); return never(); });
    const alone = new AbortController();
    const abandoned = discovery.discover(["/t"], 64, alone.signal);
    await vi.waitFor(() => expect(discovery.inFlight).toBe(1));
    alone.abort();
    await expect(abandoned).rejects.toMatchObject({ reason: "request_cancelled" });
    expect(reader.signals.get("list /t")!.aborted).toBe(true);
    expect(discovery.inFlight).toBe(0);
  });

  it("releases trees whose status is still pending at the time budget as dirty null, and aborts the abandoned read", async () => {
    const reader = git();
    reader.worktreeDirty.mockImplementation(async (path: string, options: { signal: AbortSignal }) => {
      reader.signals.set(`status ${path}`, options.signal);
      return path === "/r/b" ? never<boolean>() : false;
    });
    const discovery = new CoalescingWorktreeDiscovery(reader, { statusBudgetMs: 30 });
    const started = Date.now();
    expect(await discovery.discover(["/r"], 64, new AbortController().signal)).toEqual([
      { state: "partial", truncated: false, worktrees: [{ ...fact("/r/main"), dirty: false }, { ...fact("/r/b"), dirty: null }] },
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The slow read had no other caller, so it was aborted and left nothing in flight.
    expect(reader.signals.get("status /r/b")!.aborted).toBe(true);
    expect(discovery.statusesInFlight).toBe(0);

    // A budget already spent by the listing schedules no status read at all.
    const spent = git();
    const late = new CoalescingWorktreeDiscovery(spent, { statusBudgetMs: 0 });
    expect(await late.discover(["/r"], 64, new AbortController().signal)).toEqual([
      { state: "partial", truncated: false, worktrees: [{ ...fact("/r/main"), dirty: null }, { ...fact("/r/b"), dirty: null }] },
    ]);
    expect(spent.worktreeDirty).not.toHaveBeenCalled();
    // The default stays below the query deadline.
    expect(WORKTREE_DISCOVERY_LIMITS.statusBudgetMs).toBeLessThan(PROJECT_WORKTREES_TIMEOUT_MS);
  });

  it("keeps at most maxTrees from one listing and marks it truncated", async () => {
    const reader = git();
    reader.listTrees.mockResolvedValue(Array.from({ length: 5 }, (_, i) => fact(`/r/${i}`)));
    const [found] = await new CoalescingWorktreeDiscovery(reader, { maxTrees: 3 }).discover(["/r"], 64, new AbortController().signal);
    expect(found).toMatchObject({ state: "complete", truncated: true });
    expect(found.state !== "unavailable" && found.worktrees.map(tree => tree.path)).toEqual(["/r/0", "/r/1", "/r/2"]);
    expect(reader.worktreeDirty).toHaveBeenCalledTimes(3);
  });
});

describe("queryRelease (D2a)", () => {
  const options = (f: Fixture, commit: (value: object) => void, extra: object = {}) =>
    ({ eligible: () => true, connected: () => true, deadline: f.world.clock.now + 10_000, commit, ...extra });

  it("commits a query's value once inside its final admitted phase", async () => {
    const f = fixture(), commit = vi.fn();
    expect(await f.runner.queryRelease(f.worktrees, f.world.installation("api").context, { projectId: "project-b" }, options(f, commit))).toEqual({ status: "committed" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toMatchObject({ projectId: "project-b" });
  });

  it("refuses reads and checks eligibility before any discovery", async () => {
    const f = fixture(), commit = vi.fn(), context = f.world.installation("api").context;
    expect(await f.runner.queryRelease(f.status, context, { projectId: "project-b" }, options(f, commit)))
      .toMatchObject({ status: "refused", error: { category: "internal", reason: "invalid_operation" } });
    expect(await f.runner.queryRelease(f.worktrees, context, { projectId: "project-b" }, options(f, commit, { eligible: () => false })))
      .toMatchObject({ status: "refused", error: { reason: "release_not_eligible" } });
    expect(f.git.listTrees).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("stages a value, then decides again before committing; revocation during staging commits nothing", async () => {
    const f = fixture(), commit = vi.fn(), reader: AuthenticationContext = f.agent("reader", "reader", "project-b");
    const staged = vi.fn(async () => { f.revoke("reader"); });
    expect(await f.runner.queryRelease(f.worktrees, reader, { projectId: "project-b" }, options(f, commit, { stage: staged }))).toEqual({ status: "refused", error: notFound.error });
    expect(staged).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    const ok = vi.fn();
    const kept = f.agent("kept", "reader", "project-b");
    expect(await f.runner.queryRelease(f.worktrees, kept, { projectId: "project-b" }, options(f, ok, { stage: async () => undefined }))).toEqual({ status: "committed" });
    expect(f.git.listTrees.mock.calls.filter(([path]) => path === "/code/beta")).toHaveLength(2);
  });
});
