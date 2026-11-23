import { afterEach, describe, expect, it } from "vitest";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { OPERATIONS_HTTP_LIMITS } from "@/server/transports/operations-http";
import { OPERATIONS_MCP_ENVELOPE_OVERHEAD } from "@/server/transports/operations-mcp";
import type { ProjectId, ProjectPermission } from "@/shared/contracts/operations";
import { none, NOW, presentedBearer } from "./adapters/credential-verifier-fixture";
import { IDEMPOTENCY_RECORD_BYTES } from "./adapters/sqlite-idempotency";
import type { AuthenticationContext, CurrentAuthority } from "./authentication-context";
import { decideWith } from "./decide";
import type { EffectivePermissions } from "./grants";
import { answer, knowledgeFixture, type KnowledgeFixture, type Mode } from "./knowledge-writes-fixture";
import { KNOWLEDGE_THREAD_BODY_BYTES, KNOWLEDGE_THREAD_BODY_JSON_BYTES, KNOWLEDGE_THREAD_TITLE_BYTES, type KnowledgeThreadWriter } from "./knowledge-writes";
import { OperationRunner, type IdempotencyStore } from "./runner";

/**
 * D2b-2 decision 9 and its tests: `knowledge.create_thread` over the real
 * SQLite store, the real resolver, grants, verifiers and retention, released
 * through `mutationRelease` exactly as the transports call it. Every answer is
 * compared with its five public fields, and the durable rows (thread, history,
 * the operations idempotency record, and `knowledge_idempotency`, which this
 * path never touches) are read through the real gate.
 */
const fixtures: KnowledgeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

type Composition = Extract<ReturnType<typeof buildOperationsRuntime>, { supported: true }>;
const compose = (f: KnowledgeFixture): Composition => {
  const built = buildOperationsRuntime(f.runtimeOptions());
  if (!built.supported) throw new Error("expected a supported mode");
  return built;
};
async function world(mode: Mode = "better-auth", setup: { retention?: boolean; humans?: boolean } = {}) {
  const f = await knowledgeFixture(mode, setup); fixtures.push(f);
  const c = compose(f);
  const mint = async (listener: "api" | "mcp" | "unix", presented = none(), session: Parameters<Composition["mint"]>[2] = null) => {
    const minted = await c.mint(listener, presented, session, {});
    if (!minted.ok) throw new Error(`mint refused: ${minted.error.reason}`);
    return minted.context;
  };
  const offline = async () => {
    const minted = await c.mintOffline(() => true, {});
    if (!minted.ok) throw new Error(`offline mint refused: ${minted.error.reason}`);
    return minted.context;
  };
  return { f, c, mint, offline };
}
const input = (extra: Record<string, unknown> = {}) => ({ projectId: "project-a", title: "Release plan", body: "First draft.", ...extra });
const notStarted = (category: string, status: number, reason: string, retry = "none") => answer(category, status, reason, retry, "not_started");
const committed = { status: "committed" };

describe("knowledge.create_thread: definition and input", () => {
  it("is a declared, retained, admitted mutation on the project, excluded from the worker listener", async () => {
    const { f } = await world();
    const op = f.operation();
    expect(op).toMatchObject({ id: "knowledge.create_thread", kind: "mutation", retain: true, excludedListeners: ["worker"], publicKeys: ["thread"] });
    expect(op.effect).toMatchObject({ mode: "admitted", commitPoint: "declared" });
    expect("acquire" in op).toBe(false);
    expect(op.resources(op.parse(input()))).toEqual({ project: { kind: "project", id: "project-a" } });
    expect(op.requirement).toEqual({ require: { kind: "all", of: [
      { kind: "project", permission: "knowledge:write", resource: "project" }, { kind: "project", permission: "knowledge:read", resource: "project" }] } });
  });

  it("requires both knowledge:write and knowledge:read on the project", async () => {
    const { f } = await world();
    const op = f.operation();
    const authority: CurrentAuthority = { actor: { kind: "agent", accountId: "agent" as never }, mode: "better-auth", listener: "api", evidence: null, coordinationSession: null };
    const holding = (held: ProjectPermission[]): EffectivePermissions => ({
      installation: new Set(), everyProject: new Set(), project: id => new Set(id === "project-a" ? held : []), visible: id => id === "project-a",
    });
    const resources = { project: { ref: { kind: "project" as const, id: "project-a" }, projectId: "project-a" as ProjectId, version: 1, relation: null } };
    const verdict = (held: ProjectPermission[]) => {
      const decision = decideWith({ authority, requirement: op.requirement, resources, permissions: holding(held), now: NOW });
      return decision.allowed ? "allowed" : `${decision.category}:${decision.reason}`;
    };
    expect(verdict(["knowledge:write", "knowledge:read"])).toBe("allowed");
    expect(verdict(["knowledge:write"])).toBe("forbidden:permission_denied");
    expect(verdict(["knowledge:read"])).toBe("forbidden:permission_denied");
    expect(verdict([])).toBe("forbidden:permission_denied");
  });

  it("parses a strict object and trims title and body", async () => {
    const { f } = await world();
    const op = f.operation();
    expect(op.parse({ projectId: "project-a", title: "  Title \n", body: "\t body  " })).toEqual({ projectId: "project-a", title: "Title", body: "body" });
    const reason = (raw: unknown) => { try { op.parse(raw); return "accepted"; } catch (error) { return `${(error as { category: string }).category}:${(error as { reason: string }).reason}`; } };
    expect(reason(input({ idempotencyKey: "k" }))).toBe("invalid_request:unexpected_input");
    expect(reason(input({ extra: 1 }))).toBe("invalid_request:unexpected_input");
    expect(reason([input()])).toBe("invalid_request:invalid_input");
    expect(reason(null)).toBe("invalid_request:invalid_input");
    expect(reason(Object.defineProperty({ projectId: "project-a", body: "b" }, "title", { get: () => "t", enumerable: true }))).toBe("invalid_request:invalid_input");
    expect(reason({ projectId: "project-a", body: "b" })).toBe("invalid_request:invalid_title");
    expect(reason({ projectId: "project-a", title: "t" })).toBe("invalid_request:invalid_body");
    expect(reason(input({ projectId: "has space" }))).toBe("invalid_request:invalid_project_id");
    expect(reason(input({ projectId: "p".repeat(161) }))).toBe("invalid_request:invalid_project_id");
    expect(reason(input({ title: 7 }))).toBe("invalid_request:invalid_title");
    expect(reason(input({ title: "   " }))).toBe("invalid_request:invalid_title");
    expect(reason(input({ body: " \n " }))).toBe("invalid_request:invalid_body");
  });

  it("bounds title and body in UTF-8 bytes after trimming, and the body's JSON form", async () => {
    const { f } = await world();
    const op = f.operation();
    const accepted = (extra: Record<string, unknown>) => { try { op.parse(input(extra)); return true; } catch { return false; } };
    expect(KNOWLEDGE_THREAD_TITLE_BYTES).toBe(200);
    expect(KNOWLEDGE_THREAD_BODY_BYTES).toBe(65_536);
    expect(KNOWLEDGE_THREAD_BODY_JSON_BYTES).toBe(192 * 1024);
    expect(accepted({ title: "t".repeat(200) })).toBe(true);
    expect(accepted({ title: ` ${"t".repeat(200)} ` })).toBe(true);
    expect(accepted({ title: "t".repeat(201) })).toBe(false);
    expect(accepted({ title: "é".repeat(100) })).toBe(true);
    expect(accepted({ title: "€".repeat(67) })).toBe(false);
    expect(accepted({ body: "b".repeat(65_536) })).toBe(true);
    expect(accepted({ body: "b".repeat(65_537) })).toBe(false);
    expect(accepted({ body: "😀".repeat(16_384) })).toBe(true);
    expect(accepted({ body: `${"😀".repeat(16_384)}x` })).toBe(false);
    // Each control character is one UTF-8 byte and six JSON bytes: four letters and 32767 of them give exactly 196608 JSON bytes.
    expect(Buffer.byteLength(JSON.stringify(`xxxx${"\u0001".repeat(32_767)}`))).toBe(KNOWLEDGE_THREAD_BODY_JSON_BYTES);
    expect(accepted({ body: `xxxx${"\u0001".repeat(32_767)}` })).toBe(true);
    expect(accepted({ body: `xxxxx${"\u0001".repeat(32_767)}` })).toBe(false);
  });

  it("refuses text that does not survive storage: a lone surrogate in title or body", async () => {
    const { f } = await world();
    const op = f.operation();
    const reason = (extra: Record<string, unknown>) => { try { op.parse(input(extra)); return "accepted"; } catch (error) { return (error as { reason: string }).reason; } };
    for (const lone of ["\uD800", "\uDBFF", "\uDC00", "\uDFFF", "a\uD83Db", "a\uDE00b"]) {
      expect(reason({ title: `t${lone}` })).toBe("invalid_text");
      expect(reason({ body: `b${lone}` })).toBe("invalid_text");
    }
    expect(reason({ title: "pair 😀", body: "pair 😀" })).toBe("accepted");
  });

  it("shows which text classes the SQLite round trip changes: only lone surrogates", async () => {
    const { f } = await world();
    const roundTrip = (value: string) => f.admitted(() => (f.database.prepare("SELECT ? AS v").get(value) as { v: string }).v);
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") + "\u007f";
    for (const value of [controls, "\"quoted\" \\ back\\slash", "zażółć 日本語 😀    ﻿ �", "nul\u0000inside"]) {
      expect(await roundTrip(value)).toBe(value);
    }
    expect(await roundTrip("a\uD800b")).not.toBe("a\uD800b");
    expect(await roundTrip("a\uDC00b")).not.toBe("a\uDC00b");
  });
});

describe("knowledge.create_thread over the real store", () => {
  it("writes one thread and its created history row, releases it inside admission and replays it unchanged", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const ids = ["thread-1", "thread-2"];
    const op = f.operation({ id: () => ids.shift()! });
    const first = await f.release(c.runner, op, agent, input(), { idempotencyKey: "k-1" });
    expect(first.result).toEqual(committed);
    const thread = { id: "thread-1", projectId: "project-a", title: "Release plan", body: "First draft.", revision: 1, createdBy: "agent",
      createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
    expect(first.writes).toEqual([{ kind: "commit", value: { thread }, admitted: 1 }]);
    expect(await f.threads()).toEqual([{ id: "thread-1", project_id: "project-a", title: "Release plan", body: "First draft.", revision: 1, created_by: "agent",
      created_at: thread.createdAt, updated_at: thread.updatedAt }]);
    expect(await f.history()).toEqual([{ project_id: "project-a", record_kind: "thread", record_id: "thread-1", operation: "created", previous_json: null,
      principal_id: "agent", authentication_method: "agent_token", revision: 1, created_at: thread.createdAt }]);
    expect(await f.records()).toEqual(["k-1 account:agent completed"]);
    expect(await f.legacyIdempotency()).toBe(0);
    expect(f.notifications).toEqual(["project-a"]);
    // The replay: no second effect, no second notification, the same DTO.
    const replay = await f.release(c.runner, op, agent, input(), { idempotencyKey: "k-1" });
    expect(replay).toEqual({ result: committed, writes: [{ kind: "commit", value: { thread }, admitted: 1 }] });
    expect(await f.threads()).toHaveLength(1);
    expect(await f.history()).toHaveLength(1);
    expect(f.notifications).toEqual(["project-a"]);
    expect(await f.legacyIdempotency()).toBe(0);
    // Unkeyed calls run fresh every time and keep no record.
    const unkeyed = await f.release(c.runner, op, agent, input());
    expect(unkeyed.result).toEqual(committed);
    expect((unkeyed.writes[0].value as { thread: { id: string } }).thread.id).toBe("thread-2");
    expect(await f.records()).toEqual(["k-1 account:agent completed"]);
  });

  it("round-trips escaped controls and multibyte text: first result, legacy readback and replay are equal", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const controls = Array.from({ length: 31 }, (_, code) => String.fromCharCode(code + 1)).join("") + "\u007f";
    const body = `x ${controls} \u0000 "quotes" \\backslash\\ zażółć 日本語 😀    ﻿ x`;
    const title = "tytuł \"😀\" \u0007";
    const op = f.operation();
    const first = await f.release(c.runner, op, agent, input({ title, body }), { idempotencyKey: "text" });
    const released = (first.writes[0].value as { thread: { id: string; title: string; body: string } }).thread;
    expect(released).toMatchObject({ title, body });
    const legacy = await f.admitted(() => f.store.getThread("project-a", released.id));
    expect(legacy).toMatchObject({ id: released.id, title, body, createdBy: "agent", revision: 1 });
    const replay = await f.release(c.runner, op, agent, input({ title, body }), { idempotencyKey: "text" });
    expect(replay.writes[0].value).toEqual(first.writes[0].value);
  });

  it("proves the size bound: the stored record, the released DTO and the MCP envelope of the largest accepted thread", async () => {
    const { f, c, mint } = await world();
    const projectId = `p${"x".repeat(159)}`, accountId = `a${"y".repeat(159)}`;
    await f.admitted(() => f.store.saveKnowledgeProject({ id: projectId, name: "long", status: "active", revision: 1, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, "fixture"));
    const agent = await mint("api", await f.agent(accountId, [["operator", projectId]]));
    // The largest accepted body in JSON bytes, and a title of maximum escaping.
    const body = `xxxx${"\u0001".repeat(32_767)}`, title = "\u0001".repeat(200);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(KNOWLEDGE_THREAD_BODY_JSON_BYTES);
    const op = f.operation();
    const first = await f.release(c.runner, op, agent, { projectId, title, body }, { idempotencyKey: "largest" });
    expect(first.result).toEqual(committed);
    const dto = first.writes[0].value;
    // The analytic bound: body and title in their JSON form, the longest project and author IDs, a UUID, two ISO
    // timestamps and the field names and framing of both the retained result and the resources.
    // Project ID three times (thread, resource reference, resolution), the author once, each quoted.
    const bound = KNOWLEDGE_THREAD_BODY_JSON_BYTES + (6 * KNOWLEDGE_THREAD_TITLE_BYTES + 2) + 4 * (160 + 2) + 38 + 2 * 26 + 1024;
    expect(bound).toBeLessThan(IDEMPOTENCY_RECORD_BYTES);
    const stored = await f.admitted(() => f.database.prepare("SELECT length(CAST(resources_json AS BLOB)) + length(CAST(result_json AS BLOB)) AS bytes FROM operation_idempotency").get() as { bytes: number });
    expect(stored.bytes).toBeLessThanOrEqual(bound);
    const serialized = JSON.stringify(dto);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(bound);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(OPERATIONS_HTTP_LIMITS.responseBytes);
    // The MCP envelope: the structured copy plus the escaped text copy plus fixed framing, against the adapter's bound.
    const envelope = Buffer.byteLength(JSON.stringify({ result: { content: [{ type: "text", text: serialized }], structuredContent: dto }, jsonrpc: "2.0", id: 1 }));
    expect(envelope).toBeLessThanOrEqual(3 * OPERATIONS_HTTP_LIMITS.responseBytes + OPERATIONS_MCP_ENVELOPE_OVERHEAD);
    const replay = await f.release(c.runner, op, agent, { projectId, title, body }, { idempotencyKey: "largest" });
    expect(replay.writes[0].value).toEqual(dto);
  });

  it("denies without both grants, with no row and no record", async () => {
    const { f, c, mint } = await world();
    const reader = await mint("api", await f.agent("reader", [["reader", "project-a"]]));
    const stranger = await mint("api", await f.agent("stranger", [["operator", "project-b"]]));
    const op = f.operation();
    expect(await f.release(c.runner, op, reader, input(), { idempotencyKey: "k" })).toEqual({ result: committed,
      writes: [{ kind: "refuse", value: notStarted("forbidden", 403, "permission_denied"), admitted: 1 }] });
    expect(await f.release(c.runner, op, stranger, input(), { idempotencyKey: "k" })).toEqual({ result: committed,
      writes: [{ kind: "refuse", value: notStarted("not_found", 404, "resource_not_found"), admitted: 1 }] });
    expect(await f.threads()).toEqual([]);
    expect(await f.records()).toEqual([]);
    expect(f.notifications).toEqual([]);
  });

  it("refuses an input error inside admission, before any reservation", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    expect(await f.release(c.runner, f.operation(), agent, input({ title: "" }), { idempotencyKey: "k" })).toEqual({ result: committed,
      writes: [{ kind: "refuse", value: notStarted("invalid_request", 400, "invalid_title"), admitted: 1 }] });
    expect(await f.release(c.runner, f.operation(), agent, input(), { idempotencyKey: "not a key" })).toEqual({ result: committed,
      writes: [{ kind: "refuse", value: notStarted("invalid_request", 400, "invalid_idempotency_key"), admitted: 1 }] });
    expect(await f.records()).toEqual([]);
    expect(await f.threads()).toEqual([]);
  });

  it("answers the contract's table over the real store: conflict, in progress, previous unknown", async () => {
    const { f, c, mint } = await world();
    const presented = await f.agent("agent", [["operator", "project-a"]]);
    const agent = await mint("api", presented);
    const op = f.operation();
    await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" });
    expect((await f.release(c.runner, op, agent, input({ body: "Other." }), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: notStarted("conflict", 409, "idempotency_conflict"), admitted: 1 }]);
    // An attempt whose process died after its durable `started` write.
    const live = await dyingAttempt(f, c, agent, "live");
    expect(await f.records()).toEqual(["k account:agent completed", "live account:agent started"]);
    expect(live).toEqual([]);
    expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "live" })).writes)
      .toEqual([{ kind: "refuse", value: notStarted("conflict", 409, "request_in_progress"), admitted: 1 }]);
    await f.reopen();
    const reopened = compose(f);
    const minted = await reopened.mint("api", presented, null, {});
    if (!minted.ok) throw new Error("mint");
    expect((await f.release(reopened.runner, f.operation(), minted.context, input(), { idempotencyKey: "live" })).writes)
      .toEqual([{ kind: "refuse", value: answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown"), admitted: 1 }]);
    expect(await f.records()).toEqual(["k account:agent completed", "live account:agent unknown"]);
    expect(await f.threads()).toHaveLength(1);
  });

  it("keeps principals isolated: the same key from two accounts runs twice", async () => {
    const { f, c, mint } = await world();
    const one = await mint("api", await f.agent("one", [["operator", "project-a"]]));
    const two = await mint("api", await f.agent("two", [["operator", "project-a"]]));
    const op = f.operation();
    await f.release(c.runner, op, one, input(), { idempotencyKey: "shared" });
    await f.release(c.runner, op, two, input(), { idempotencyKey: "shared" });
    expect((await f.threads()).map(row => row.created_by)).toEqual(expect.arrayContaining(["one", "two"]));
    expect(await f.records()).toEqual(["shared account:one completed", "shared account:two completed"]);
  });

  it("refuses a replay after revocation as not_found and leaves the record alone", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const op = f.operation();
    await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" });
    await f.revoke("agent");
    expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: notStarted("not_found", 404, "resource_not_found"), admitted: 1 }]);
    expect(await f.records()).toEqual(["k account:agent completed"]);
  });

  it("replays after the project is archived, and refuses a fresh create there before the commit point", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const op = f.operation();
    const first = await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" });
    await f.setProjectStatus("project-a", "archived");
    // A project's resolution keeps version 1 when it is archived, so the stored resolution still matches.
    expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" })).writes).toEqual(first.writes);
    expect((await f.release(c.runner, op, agent, input({ title: "New" }), { idempotencyKey: "fresh" })).writes)
      .toEqual([{ kind: "refuse", value: notStarted("conflict", 409, "project_archived"), admitted: 1 }]);
    expect((await f.release(c.runner, op, agent, input({ title: "New" }))).writes)
      .toEqual([{ kind: "refuse", value: notStarted("conflict", 409, "project_archived"), admitted: 1 }]);
    // The reservation was released before the refusal: the key has no record, and nothing else was written.
    expect(await f.records()).toEqual(["k account:agent completed"]);
    expect(await f.threads()).toHaveLength(1);
    expect(f.notifications).toEqual(["project-a"]);
  });

  it("refuses a changed resolution between the decision and the effect, with no row and the reservation released", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    let calls = 0;
    const resolver = {
      resolve: (ref: Parameters<typeof c.runtime.resolver.resolve>[0]) => {
        const resolved = c.runtime.resolver.resolve(ref);
        // Phase 1 sees version 1; phase 3 sees the project re-created.
        return resolved && ++calls > 1 ? { ...resolved, version: 2 } : resolved;
      },
      listProjects: () => c.runtime.resolver.listProjects(),
    };
    const runner = new OperationRunner({ ...c.runtime, resolver, idempotency: f.retention!.idempotency, fingerprintKey: f.retention!.fingerprintKey });
    expect((await f.release(runner, f.operation(), agent, input(), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: notStarted("conflict", 409, "resource_changed"), admitted: 1 }]);
    expect(await f.records()).toEqual([]);
    expect(await f.threads()).toEqual([]);
  });

  it("rolls back both rows when the history insert fails; the caller gets outcome_unknown and a keyed retry creates nothing", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    await f.admitted(() => f.database.exec("CREATE TRIGGER fail_thread_history BEFORE INSERT ON knowledge_history WHEN NEW.record_kind='thread' BEGIN SELECT RAISE(ABORT, 'injected'); END"));
    const op = f.operation();
    expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: answer("outcome_unknown", 409, "effect_interrupted", "inspect_first", "unknown"), admitted: 1 }]);
    expect(await f.threads()).toEqual([]);
    expect(await f.history()).toEqual([]);
    expect(await f.records()).toEqual(["k account:agent unknown"]);
    expect(f.notifications).toEqual([]);
    await f.admitted(() => f.database.exec("DROP TRIGGER fail_thread_history"));
    expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown"), admitted: 1 }]);
    expect(await f.threads()).toEqual([]);
  });

  it("replays after the controller's store is reopened", async () => {
    const { f, c, mint } = await world();
    const presented = await f.agent("agent", [["operator", "project-a"]]);
    const first = await f.release(c.runner, f.operation(), await mint("api", presented), input(), { idempotencyKey: "k" });
    await f.reopen();
    const next = compose(f);
    const minted = await next.mint("api", presented, null, {});
    if (!minted.ok) throw new Error("mint");
    const replay = await f.release(next.runner, f.operation(), minted.context, input(), { idempotencyKey: "k" });
    expect(replay.writes).toEqual(first.writes);
    expect(await f.threads()).toHaveLength(1);
    expect(f.notifications).toEqual(["project-a"]);
  });

  it("a crash between the commit point and the insert: started survives, repair makes it unknown, no thread", async () => {
    const { f, mint, c } = await world();
    const presented = await f.agent("agent", [["operator", "project-a"]]);
    expect(await dyingAttempt(f, c, await mint("api", presented), "k")).toEqual([]);
    expect(await f.records()).toEqual(["k account:agent started"]);
    await f.reopen();
    expect(await f.records()).toEqual(["k account:agent unknown"]);
    const next = compose(f);
    const minted = await next.mint("api", presented, null, {});
    if (!minted.ok) throw new Error("mint");
    expect((await f.release(next.runner, f.operation(), minted.context, input(), { idempotencyKey: "k" })).writes)
      .toEqual([{ kind: "refuse", value: answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown"), admitted: 1 }]);
    expect(await f.threads()).toEqual([]);
    expect(await f.history()).toEqual([]);
  });
});

/**
 * An attempt whose process dies right after the commit point: the durable
 * `started` write lands, then neither the insert nor any later store write
 * does. Returns what reached the caller.
 */
async function dyingAttempt(f: KnowledgeFixture, c: Composition, context: AuthenticationContext, key: string) {
  const dead = { now: false };
  const store = f.retention!.idempotency;
  const dying: IdempotencyStore = {
    get: each => store.get(each),
    put: (each, record) => { if (dead.now) throw new Error("process gone"); store.put(each, record); },
    release: (each, attempt) => { if (dead.now) throw new Error("process gone"); store.release(each, attempt); },
  };
  const writer = f.store.knowledgeThreadWriter();
  const crashing: KnowledgeThreadWriter = { ...writer, createThread: () => { dead.now = true; throw new Error("process gone"); } };
  const runner = new OperationRunner({ ...c.runtime, idempotency: dying, fingerprintKey: f.retention!.fingerprintKey });
  const released = await f.release(runner, f.operation({ writer: crashing }), context, input(), { idempotencyKey: key, connected: () => !dead.now });
  return released.writes;
}

describe("knowledge.create_thread: authorship (decision 8)", () => {
  const authored = async (f: KnowledgeFixture, runner: Composition["runner"], context: AuthenticationContext) => {
    const released = await f.release(runner, f.operation(), context, input());
    expect(released.result).toEqual(committed);
    const thread = (released.writes[0].value as { thread: { id: string; createdBy: string } }).thread;
    const [history] = (await f.history()).filter(row => row.record_id === thread.id);
    const [row] = (await f.threads()).filter(each => each.id === thread.id);
    return { createdBy: thread.createdBy, created_by: row.created_by, principal_id: history.principal_id, authentication_method: history.authentication_method };
  };

  it("human: the account ID and provider_session", async () => {
    const { f, c, mint } = await world("better-auth", { humans: true });
    const h = await f.human("alice", [["operator", "project-a"]]);
    expect(await authored(f, c.runner, await mint("api", h.presented, h.session)))
      .toEqual({ createdBy: "alice", created_by: "alice", principal_id: "alice", authentication_method: "provider_session" });
  });

  it("agent: the account ID and agent_token", async () => {
    const { f, c, mint } = await world();
    expect(await authored(f, c.runner, await mint("mcp", await f.agent("bot", [["operator", "project-a"]]))))
      .toEqual({ createdBy: "bot", created_by: "bot", principal_id: "bot", authentication_method: "agent_token" });
  });

  it("installation in token mode: installation and installation_token", async () => {
    const { f, c, mint } = await world("token");
    expect(await authored(f, c.runner, await mint("api", presentedBearer(f.installationSecret))))
      .toEqual({ createdBy: "installation", created_by: "installation", principal_id: "installation", authentication_method: "installation_token" });
  });

  it("installation in open mode: installation and none", async () => {
    const { f, c, mint } = await world("open");
    expect(await authored(f, c.runner, await mint("mcp")))
      .toEqual({ createdBy: "installation", created_by: "installation", principal_id: "installation", authentication_method: "none" });
  });

  it.each(["unix", "offline"] as const)("operator (%s), provisional: installation and none, in every mode", async via => {
    for (const mode of ["open", "token", "better-auth"] as const) {
      const { f, c, mint, offline } = await world(mode);
      const context = via === "unix" ? await mint("unix") : await offline();
      expect(await authored(f, c.runner, context))
        .toEqual({ createdBy: "installation", created_by: "installation", principal_id: "installation", authentication_method: "none" });
    }
  });

  it("refuses a missing, inactive or wrong-kind author row as internal before the commit point", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const writer = f.store.knowledgeThreadWriter();
    for (const principal of [null, { kind: "agent", status: "revoked" }, { kind: "worker", status: "active" }, { kind: "installation", status: "active" }, "agent"]) {
      const op = f.operation({ writer: { ...writer, principal: () => principal } });
      expect((await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" })).writes)
        .toEqual([{ kind: "refuse", value: notStarted("internal", 500, "author_unverified"), admitted: 1 }]);
    }
    // The reservation was given back each time; nothing was written.
    expect(await f.records()).toEqual([]);
    expect(await f.threads()).toEqual([]);
  });

  it("a human whose stored principal row is no longer active is refused by the grants before the author check", async () => {
    const { f, c, mint } = await world("better-auth", { humans: true });
    const h = await f.human("alice", [["operator", "project-a"]]);
    const context = await mint("api", h.presented, h.session);
    await f.admitted(() => f.database.prepare("UPDATE remote_principals SET status='revoked' WHERE id='alice'").run());
    // The grants snapshot knows no active account, so the project is not visible; the author check (above,
    // through the port) is the second line that holds where a principal row and the grants disagree.
    expect((await f.release(c.runner, f.operation(), context, input())).writes)
      .toEqual([{ kind: "refuse", value: notStarted("not_found", 404, "resource_not_found"), admitted: 1 }]);
    expect(await f.threads()).toEqual([]);
  });

  it("refuses the installation without the seeded principal row", async () => {
    const { f, c, mint } = await world("open");
    const writer = f.store.knowledgeThreadWriter();
    const op = f.operation({ writer: { ...writer, principal: id => (id === "installation" ? null : writer.principal(id)) } });
    expect((await f.release(c.runner, op, await mint("api"), input())).writes)
      .toEqual([{ kind: "refuse", value: notStarted("internal", 500, "author_unverified"), admitted: 1 }]);
    // The seeded row itself is active.
    expect(await f.admitted(() => writer.principal("installation"))).toEqual({ kind: "installation", status: "active" });
  });
});

describe("knowledge.create_thread: notification", () => {
  it("notifies once on a fresh success even when the caller is gone, never on a replay or a failed insert", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const op = f.operation();
    let open = true;
    // The caller leaves during the effect: completion still runs, the release is refused without a write.
    const writer = f.store.knowledgeThreadWriter();
    const leaving = f.operation({ writer: { ...writer, createThread: (thread, author) => { writer.createThread(thread, author); open = false; } } });
    const gone = await f.release(c.runner, leaving, agent, input(), { idempotencyKey: "k", connected: () => open });
    expect(gone).toEqual({ result: { status: "refused", error: answer("unavailable", 503, "request_cancelled", "none", "committed") }, writes: [] });
    expect(f.notifications).toEqual(["project-a"]);
    expect(await f.records()).toEqual(["k account:agent completed"]);
    await f.release(c.runner, op, agent, input(), { idempotencyKey: "k" });
    expect(f.notifications).toEqual(["project-a"]);
    await f.admitted(() => f.database.exec("CREATE TRIGGER fail_thread BEFORE INSERT ON knowledge_threads BEGIN SELECT RAISE(ABORT, 'injected'); END"));
    await f.release(c.runner, op, agent, input({ title: "Second" }));
    expect(f.notifications).toEqual(["project-a"]);
  });
});

describe("knowledge.create_thread beside the legacy path", () => {
  it("new rows read through the legacy thread and history readers; a legacy write interleaves with a new one", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const op = f.operation({ id: () => "new-1" });
    await f.release(c.runner, op, agent, input({ title: "New one" }), { idempotencyKey: "k" });
    const iso = new Date(NOW).toISOString();
    // The legacy store write, with its own idempotency table.
    await f.admitted(() => f.store.createThread({ id: "legacy-1", projectId: "project-a", title: "Legacy", body: "Old path.", revision: 1, createdBy: "agent", createdAt: iso, updatedAt: iso },
      { actor: { principalId: "agent", principalKind: "agent", credentialId: "c", authenticationMethod: "agent_token" }, projectId: "project-a", idempotencyKey: "k", requestHash: "0".repeat(64) }));
    const op2 = f.operation({ id: () => "new-2" });
    await f.release(c.runner, op2, agent, input({ title: "New two" }), { idempotencyKey: "k2" });
    const listed = await f.admitted(() => f.store.listThreads("project-a", 10, 0));
    expect(listed.items.map(thread => thread.id).sort()).toEqual(["legacy-1", "new-1", "new-2"]);
    expect(await f.admitted(() => f.store.getThread("project-a", "new-1"))).toMatchObject({ id: "new-1", title: "New one", createdBy: "agent", revision: 1 });
    const history = await f.admitted(() => f.store.listHistory("project-a", "thread", "new-1", 10, 0));
    expect(history.items).toEqual([expect.objectContaining({ recordKind: "thread", recordId: "new-1", operation: "created", principalId: "agent", authenticationMethod: "agent_token", revision: 1 })]);
    // Neither path reads the other's idempotency: the legacy key `k` and the new key `k` are separate.
    expect(await f.legacyIdempotency()).toBe(1);
    expect(await f.records()).toEqual(["k account:agent completed", "k2 account:agent completed"]);
  });
});

describe("knowledge.create_thread: release policy around the effect", () => {
  it("a caller gone before the effect: no row, reservation released", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const released = await f.release(c.runner, f.operation(), agent, input(), { idempotencyKey: "k", connected: () => false });
    expect(released).toEqual({ result: { status: "refused", error: notStarted("unavailable", 503, "request_cancelled", "retry") }, writes: [] });
    expect(await f.records()).toEqual([]);
    expect(await f.threads()).toEqual([]);
  });

  it("the deadline passing during the effect: one thread, completed record, no write", async () => {
    const { f, c, mint } = await world();
    const agent = await mint("api", await f.agent("agent", [["operator", "project-a"]]));
    const writer = f.store.knowledgeThreadWriter();
    const op = f.operation({ writer: { ...writer, createThread: (thread, author) => { writer.createThread(thread, author); f.clock.now = NOW + 10_000; } } });
    const released = await f.release(c.runner, op, agent, input(), { idempotencyKey: "k", deadline: NOW + 5_000 });
    expect(released).toEqual({ result: { status: "refused", error: answer("unavailable", 503, "release_timed_out", "none", "committed") }, writes: [] });
    expect(await f.threads()).toHaveLength(1);
    expect(await f.records()).toEqual(["k account:agent completed"]);
  });
});
