import { projectId, type KnowledgeCreateThreadResult, type KnowledgeThreadDto, type ProjectId } from "@/shared/contracts/operations";
import type { CurrentAuthority } from "./authentication-context";
import { OperationError } from "./errors";
import type { AdmittedCommitScope, MutationOperation } from "./operation";
import { pick } from "./release";
import { allOf, onProject } from "./requirements";
import { absorb, isThenable } from "./synchronous";

/**
 * The first retained mutation of the operations surface (D2b-2):
 * `knowledge.create_thread` (dispositions section 3.8, row 7.23).
 *
 * Built once by bootstrap over three ports: the store's thread writer
 * (`SqliteStateStore.knowledgeThreadWriter()`), a total change notification
 * and an ID generator. It imports nothing from the Knowledge module and shares
 * no code or idempotency table with the legacy `create_thread`: both write the
 * same thread and history tables, and this path never reads or writes
 * `knowledge_idempotency`.
 *
 * One admitted phase on the owner's connection reads the project's status and
 * refuses an archived project, resolves and verifies the author from the
 * phase's authority, crosses the declared commit point (the durable `started`
 * record, outside any transaction), and then inserts the thread and its
 * `created` history row in one store transaction.
 */

/** Trimmed title, UTF-8 bytes, as the legacy write. */
export const KNOWLEDGE_THREAD_TITLE_BYTES = 200;
/** Trimmed body, UTF-8 bytes, as the legacy write. */
export const KNOWLEDGE_THREAD_BODY_BYTES = 65_536;
/**
 * The body's JSON string form, `Buffer.byteLength(JSON.stringify(body))`. A
 * body of escaped characters can be six times its UTF-8 size; this bound keeps
 * the retained result below the idempotency record bound (256 KiB) and the
 * released DTO below the response ceiling (256 KiB).
 */
export const KNOWLEDGE_THREAD_BODY_JSON_BYTES = 192 * 1024;

/** Synchronous storage facts and the one write; the operation validates every answer. */
export interface KnowledgeThreadWriter {
  /** The stored status of the project (`active` or `archived`), or null. */
  projectStatus(projectId: string): unknown;
  /** The stored `{ kind, status }` of a principal, or null. */
  principal(id: string): unknown;
  /** The thread and its `created` history row in one transaction; throws when nothing was written. */
  createThread(thread: KnowledgeThreadDto, author: { principalId: string; authenticationMethod: string }): void;
}

export interface KnowledgeWritePorts {
  writer: KnowledgeThreadWriter;
  /**
   * Notifies subscribers that the project's Knowledge changed. Total: bootstrap
   * adapts the controller's scoped publisher so that a failure stays inside the
   * adapter; offline it is a no-op. Called only after a fresh success.
   */
  changed(projectId: ProjectId): void;
  /** The new thread's ID (`randomUUID` in production). */
  id(): string;
}

interface CreateThreadInput { projectId: ProjectId; title: string; body: string }

const INPUT_KEYS: readonly string[] = Object.freeze(["projectId", "title", "body"]);
const THREAD_KEYS = Object.freeze(["id", "projectId", "title", "body", "revision", "createdBy", "createdAt", "updatedAt"] as const);
const RESULT_KEYS = Object.freeze(["thread"] as const);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** A lone surrogate: text that does not survive UTF-8 storage. */
const ILL_FORMED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const invalid = (reason: string) => new OperationError("invalid_request", reason);
const corrupt = (reason: string) => new OperationError("internal", reason);
const own = (source: unknown, key: string): unknown => {
  if (typeof source !== "object" || source === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

/** A synchronous port answer; a throw or thenable is `internal`/`reason`. */
function port<T>(call: () => T, reason: string): T {
  let value: T;
  try { value = call(); } catch { throw corrupt(reason); }
  if (isThenable(value)) { absorb(value); throw corrupt(reason); }
  return value;
}

function plainObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("invalid_input");
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw invalid("invalid_input");
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !INPUT_KEYS.includes(key)) throw invalid("unexpected_input");
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) throw invalid("invalid_input");
  }
  return raw as Record<string, unknown>;
}

/** Trimmed text of 1 to `maximum` UTF-8 bytes that survives storage unchanged. */
function storedText(value: unknown, maximum: number, reason: string): string {
  if (typeof value !== "string") throw invalid(reason);
  const trimmed = value.trim();
  if (ILL_FORMED.test(trimmed)) throw invalid("invalid_text");
  const bytes = Buffer.byteLength(trimmed, "utf8");
  if (bytes < 1 || bytes > maximum) throw invalid(reason);
  return trimmed;
}

function parse(raw: unknown): CreateThreadInput {
  const input = plainObject(raw);
  let id: ProjectId;
  try { id = projectId(input.projectId); } catch { throw invalid("invalid_project_id"); }
  const title = storedText(input.title, KNOWLEDGE_THREAD_TITLE_BYTES, "invalid_title");
  const body = storedText(input.body, KNOWLEDGE_THREAD_BODY_BYTES, "invalid_body");
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > KNOWLEDGE_THREAD_BODY_JSON_BYTES) throw invalid("invalid_body");
  return { projectId: id, title, body };
}

/**
 * Decision 8: the author from the phase's authority, never from input. The
 * first four rows equal the legacy attribution; the operator row is
 * provisional (accepted deviation, release item).
 */
function authorOf(authority: CurrentAuthority): { principalId: string; authenticationMethod: string; kinds: readonly string[] } {
  const actor = authority.actor;
  switch (actor.kind) {
    case "human": return { principalId: actor.accountId, authenticationMethod: "provider_session", kinds: ["owner", "human"] };
    case "agent": return { principalId: actor.accountId, authenticationMethod: "agent_token", kinds: ["agent"] };
    case "installation":
      if (authority.mode === "token") return { principalId: "installation", authenticationMethod: "installation_token", kinds: ["installation"] };
      if (authority.mode === "open") return { principalId: "installation", authenticationMethod: "none", kinds: ["installation"] };
      throw corrupt("author_unavailable");
    case "operator": return { principalId: "installation", authenticationMethod: "none", kinds: ["installation"] };
    default: throw corrupt("author_unavailable");
  }
}

/** The released thread: exactly the eight named fields, validated; anything else is `internal`. */
function threadOf(value: unknown): KnowledgeThreadDto {
  const id = own(value, "id"), project = own(value, "projectId"), title = own(value, "title"), body = own(value, "body");
  const revision = own(value, "revision"), createdBy = own(value, "createdBy"), createdAt = own(value, "createdAt"), updatedAt = own(value, "updatedAt");
  if (typeof id !== "string" || !ID.test(id) || typeof project !== "string" || !ID.test(project) || typeof title !== "string" || typeof body !== "string"
    || revision !== 1 || typeof createdBy !== "string" || !ID.test(createdBy) || typeof createdAt !== "string" || typeof updatedAt !== "string") {
    throw corrupt("invalid_stored_thread");
  }
  return pick({ id, projectId: project as ProjectId, title, body, revision, createdBy, createdAt, updatedAt }, THREAD_KEYS);
}

function createThreadOperation(ports: KnowledgeWritePorts): MutationOperation<CreateThreadInput, KnowledgeThreadDto, KnowledgeCreateThreadResult> {
  return {
    id: "knowledge.create_thread",
    kind: "mutation",
    // H (API on TCP and the unix socket), MCP and CLI: never the worker listener.
    // MCP is excluded until its tool descriptor is mounted with it.
    excludedListeners: Object.freeze(["worker", "mcp"] as const),
    // Writes also require knowledge:read: the response carries the retained content.
    requirement: Object.freeze({ require: allOf(onProject("knowledge:write", "project"), onProject("knowledge:read", "project")) }),
    retain: true,
    parse,
    resources: input => ({ project: { kind: "project", id: input.projectId } }),
    effect: {
      mode: "admitted",
      commitPoint: "declared",
      run(input: CreateThreadInput, scope: AdmittedCommitScope): KnowledgeThreadDto {
        // 1. The archived state limits writes; it is not an authorization rule.
        const status = port(() => ports.writer.projectStatus(input.projectId), "project_read_failed");
        if (status === "archived") throw new OperationError("conflict", "project_archived");
        if (status !== "active") throw corrupt("invalid_stored_project");
        // 2. The author, verified before the commit point.
        const author = authorOf(scope.authority);
        const principal = port(() => ports.writer.principal(author.principalId), "principal_read_failed");
        if (own(principal, "status") !== "active" || !author.kinds.includes(own(principal, "kind") as string)) throw corrupt("author_unverified");
        const id = port(() => ports.id(), "thread_id_failed");
        if (typeof id !== "string" || !ID.test(id)) throw corrupt("thread_id_failed");
        // The phase clock; an unusable time is an untyped failure before the commit point.
        const now = new Date(scope.now).toISOString();
        const thread: KnowledgeThreadDto = {
          id, projectId: input.projectId, title: input.title, body: input.body, revision: 1, createdBy: author.principalId, createdAt: now, updatedAt: now,
        };
        // 3. The durable `started` record, never inside the thread transaction.
        scope.commit();
        // 4. Thread and history in one store transaction. A throw from here is an unknown outcome.
        ports.writer.createThread(thread, { principalId: author.principalId, authenticationMethod: author.authenticationMethod });
        return thread;
      },
    },
    finalize(input, outcome) {
      // A missed refresh never turns a durable thread into an unknown record: the port is total.
      if (outcome.ok) ports.changed(input.projectId);
    },
    publicKeys: RESULT_KEYS,
    project(result) {
      return pick({ thread: threadOf(result) }, RESULT_KEYS);
    },
  };
}

/** The frozen definition over bootstrap's ports. */
export function createKnowledgeWrites(ports: KnowledgeWritePorts) {
  if (typeof ports?.writer?.projectStatus !== "function" || typeof ports.writer.principal !== "function" || typeof ports.writer.createThread !== "function"
    || typeof ports.changed !== "function" || typeof ports.id !== "function") {
    throw new TypeError("Invalid knowledge write ports.");
  }
  return Object.freeze({ createThread: Object.freeze(createThreadOperation(ports)) });
}
