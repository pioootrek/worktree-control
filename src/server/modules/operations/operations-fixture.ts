/**
 * In-memory fixtures for the authorization contract tests. Not exported from
 * the module's public API and not used by production code.
 */
import type { DatabaseAdmission, DatabaseAdmissionOptions } from "@/server/database-admission";
import { accountId, projectId, type AccountId, type AuthenticationMode, type ListenerKind, type ProjectId } from "@/shared/contracts/operations";
import type { AcceptedPath, PresentedCredentials } from "./acceptance";
import {
  createListenerBoundary,
  type Actor, type CoordinationSessionRef, type CredentialIdentity, type CredentialVerifier, type ProviderEvidence, type VerifiedCredential,
} from "./authentication-context";
import type { IdempotencyKey, IdempotencyRecord, IdempotencyStore, OperationObserver, OperationRuntime } from "./runner";
import type { GrantsSnapshot, StoredGrant } from "./grants";
import type { ResolvedResource, ResourceKind, ResourceRef, ResourceRelation } from "./requirements";
import type { ResourceResolver } from "./resolver";

interface Entry { projectId: ProjectId; version: number; relation: ResourceRelation | null }

/**
 * Separate maps per namespace; no lookup ever crosses into another map.
 * Versions come from one counter, so they are never reused for a reference,
 * even after delete and recreate (an obligation of every real resolver).
 */
export class InMemoryResolver implements ResourceResolver {
  readonly #entries = new Map<ResourceKind, Map<string, Entry>>();
  readonly #projects: ProjectId[] = [];
  #version = 0;
  resolveCalls = 0;

  addProject(id: ProjectId): this {
    if (!this.#projects.includes(id)) this.#projects.push(id);
    return this.put({ kind: "project", id }, id);
  }
  removeProject(id: ProjectId): this {
    this.#projects.splice(this.#projects.indexOf(id), 1);
    this.#entries.get("project")?.delete(id);
    return this;
  }
  put(ref: ResourceRef, projectId: ProjectId, relation: ResourceRelation | null = null): this {
    const map = this.#entries.get(ref.kind) ?? new Map<string, Entry>();
    map.set(ref.id, { projectId, version: ++this.#version, relation });
    this.#entries.set(ref.kind, map);
    return this;
  }
  /** Moves a resource to another project, as a registration move would. */
  move(ref: ResourceRef, projectId: ProjectId): this {
    const entry = this.#entries.get(ref.kind)?.get(ref.id);
    if (!entry) throw new Error("Unknown fixture resource.");
    return this.put(ref, projectId, entry.relation);
  }
  setRelation(ref: ResourceRef, relation: ResourceRelation | null): this {
    const entry = this.#entries.get(ref.kind)?.get(ref.id);
    if (!entry) throw new Error("Unknown fixture resource.");
    return this.put(ref, entry.projectId, relation);
  }
  delete(ref: ResourceRef): this { this.#entries.get(ref.kind)?.delete(ref.id); return this; }

  resolve(ref: ResourceRef): ResolvedResource | null {
    this.resolveCalls++;
    const entry = this.#entries.get(ref.kind)?.get(ref.id);
    return entry ? { ref: { ...ref }, projectId: entry.projectId, version: entry.version, relation: entry.relation } : null;
  }
  listProjects(): readonly ProjectId[] { return [...this.#projects]; }
}

export class InMemoryGrants implements GrantsSnapshot {
  readonly kinds = new Map<AccountId, "human" | "agent">();
  grants: StoredGrant[] = [];
  account(id: AccountId, kind: "human" | "agent"): this { this.kinds.set(id, kind); return this; }
  grant(grant: StoredGrant): this { this.grants.push(grant); return this; }
  revokeAll(accountId: AccountId): this { this.grants = this.grants.filter(grant => grant.accountId !== accountId); return this; }
  accountKind(accountId: AccountId): "human" | "agent" | null { return this.kinds.get(accountId) ?? null; }
  grantsFor(accountId: AccountId): readonly StoredGrant[] { return this.grants.filter(grant => grant.accountId === accountId); }
}

/** Credential store fixture: secret -> credential; `revoke` and `rotate` change current state. */
export class FakeVerifier implements CredentialVerifier {
  readonly #bySecret = new Map<string, VerifiedCredential>();
  readonly #current = new Map<string, VerifiedCredential | null>();
  key = (identity: CredentialIdentity) => `${identity.path}\u0000${identity.credentialId}`;

  register(secret: string | null, path: AcceptedPath, credentialId: string, actor: Actor,
    extra: { evidence?: ProviderEvidence | null; session?: CoordinationSessionRef | null } = {}): VerifiedCredential {
    const credential: VerifiedCredential = {
      identity: { path, credentialId, generation: 1 }, actor,
      evidence: extra.evidence ?? null, coordinationSession: extra.session ?? null,
    };
    this.#bySecret.set(`${path}\u0000${secret ?? ""}`, credential);
    this.#current.set(this.key(credential.identity), credential);
    return credential;
  }
  revoke(path: AcceptedPath, credentialId: string): void { this.#current.set(`${path}\u0000${credentialId}`, null); }
  update(path: AcceptedPath, credentialId: string, change: (current: VerifiedCredential) => VerifiedCredential): void {
    const key = `${path}\u0000${credentialId}`;
    const current = this.#current.get(key);
    if (current) this.#current.set(key, change(current));
  }
  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null {
    const credential = this.#bySecret.get(`${path}\u0000${secret ?? ""}`);
    return credential ? this.#current.get(this.key(credential.identity)) ?? null : null;
  }
  current(identity: CredentialIdentity): VerifiedCredential | null { return this.#current.get(this.key(identity)) ?? null; }
}

export interface AdmissionEvent { n: number; kind: "run" | "readmit"; reserved: boolean }

/** Error shape the real connection gate throws when it refuses admission. */
export function admissionRefusal(code: "busy" | "closed" = "busy"): Error {
  return Object.assign(new Error(`admission ${code}`), { name: "ExclusiveConnectionError", code });
}

/**
 * Admission double with observable state. `onAdmit` runs before each fresh
 * admission and each re-admission; it may change the world or throw a refusal.
 */
export class FakeAdmission implements DatabaseAdmission {
  admitted = false;
  events: AdmissionEvent[] = [];
  onAdmit: ((event: AdmissionEvent) => void) | null = null;

  #enter(kind: AdmissionEvent["kind"], reserved: boolean): void {
    const event = { n: this.events.length + 1, kind, reserved };
    this.events.push(event);
    this.onAdmit?.(event);
    this.admitted = true;
  }
  async run<T>(operation: () => T | Promise<T>, options?: DatabaseAdmissionOptions): Promise<T> {
    if (this.admitted) return operation();
    if (options?.signal?.aborted) throw admissionRefusal("closed");
    this.#enter("run", !!options?.reserved);
    try { return await operation(); } finally { this.admitted = false; }
  }
  detached<T>(operation: () => T | Promise<T>, options?: DatabaseAdmissionOptions): Promise<T> {
    if (this.admitted) throw new Error("Fixture does not nest detached admissions.");
    return this.run(operation, options);
  }
  async idle<T>(operation: () => Promise<T>, options?: DatabaseAdmissionOptions): Promise<T> {
    if (!this.admitted) return operation();
    this.admitted = false;
    let result: T;
    try { result = await operation(); } finally {
      this.events.push({ n: this.events.length + 1, kind: "readmit", reserved: !!options?.reserved });
      this.onAdmit?.(this.events.at(-1)!);
      this.admitted = true;
    }
    return result;
  }
  tryRun<T>(operation: () => T): { ran: true; value: T } | { ran: false } { return { ran: true, value: operation() }; }
  outside<T>(operation: () => T): T { return operation(); }
}

export const P = (value: string) => projectId(value);
export const A = (value: string) => accountId(value);
const noCredentials: PresentedCredentials = { bearers: [], providerSession: null, legacySecret: false, browserHeaders: false };
export const presented = (change: Partial<PresentedCredentials> = {}): PresentedCredentials => ({ ...noCredentials, ...change });

/** A small installation: verifier, grants, resolver and boundaries for every mode. */
export function createWorld(options: { now?: number } = {}) {
  const verifier = new FakeVerifier();
  const grants = new InMemoryGrants();
  const resolver = new InMemoryResolver();
  const admission = new FakeAdmission();
  const clock = { now: options.now ?? Date.parse("2026-11-13T12:00:00.000Z") };
  const listenerOpen = { value: true };
  const boundary = (mode: AuthenticationMode, listener: Exclude<ListenerKind, "offline">) =>
    createListenerBoundary({ mode, listener, verifier, open: () => listenerOpen.value });
  let sessions = 0;
  const session = (credentialId: string): CoordinationSessionRef => ({ id: `session-${++sessions}`, generation: 1, credentialId });

  const human = (name: string, extra: { authenticatedAt?: number | null; listener?: "api" } = {}) => {
    const id = A(name);
    grants.account(id, "human");
    const credentialId = `provider-${name}`;
    const coordination = session(credentialId);
    const at = extra.authenticatedAt === undefined ? clock.now - 1_000 : extra.authenticatedAt;
    verifier.register(`cookie-${name}`, "provider_session", credentialId, { kind: "human", accountId: id },
      { evidence: at === null ? null : { authenticatedAt: at }, session: coordination });
    const context = boundary("better-auth", "api").mint(presented({ providerSession: { secret: `cookie-${name}` }, browserHeaders: true }));
    return { id, credentialId, session: coordination, context };
  };
  const agent = (name: string, listener: "api" | "mcp" | "worker" = "mcp") => {
    const id = A(name);
    grants.account(id, "agent");
    const credentialId = `agent-${name}`;
    const coordination = session(credentialId);
    verifier.register(`token-${name}`, "agent_token", credentialId, { kind: "agent", accountId: id }, { session: coordination });
    const context = boundary("better-auth", listener).mint(presented({ bearers: [{ class: "agent_token", secret: `token-${name}` }] }));
    return { id, credentialId, session: coordination, context };
  };
  const installation = (listener: "api" | "mcp" | "worker" = "mcp") => {
    const credentialId = `installation-${++sessions}`;
    const coordination = session(credentialId);
    verifier.register(`wsi-${credentialId}`, "installation_token", credentialId, { kind: "installation" }, { session: coordination });
    const context = boundary("token", listener).mint(presented({ bearers: [{ class: "installation_token", secret: `wsi-${credentialId}` }] }));
    return { credentialId, session: coordination, context };
  };
  const operator = () => boundary("better-auth", "unix").mint(presented());
  /** Every disposal failure the runner reported, in order. */
  const disposalFailures: { operationId: string; kind: string }[] = [];
  const observer: OperationObserver = { streamDisposalFailed: event => { disposalFailures.push({ ...event }); } };
  const runtime = (extra: { completionDeadlineMs?: number; idempotency?: IdempotencyStore; disposeTimeoutMs?: number } = {}): OperationRuntime => ({
    admission, resolver, grants: () => grants, now: () => clock.now, completionDeadlineMs: extra.completionDeadlineMs ?? 50,
    idempotency: extra.idempotency, disposeTimeoutMs: extra.disposeTimeoutMs ?? 50, observer,
  });
  return { verifier, grants, resolver, admission, clock, listenerOpen, boundary, human, agent, installation, operator, runtime, disposalFailures };
}

/**
 * Idempotency store double. Stores and returns copies, as a real adapter must.
 * `failOn` makes one transition throw: `get`, a `put` of the named state, or `release`.
 */
export class MemoryIdempotency implements IdempotencyStore {
  readonly entries = new Map<string, IdempotencyRecord>();
  failOn: Set<"get" | "release" | IdempotencyRecord["state"]> = new Set();
  #key = (key: IdempotencyKey) => JSON.stringify([key.operationId, key.principal, key.idempotencyKey]);
  get(key: IdempotencyKey): IdempotencyRecord | null {
    if (this.failOn.has("get")) throw new Error("store get failed /secret");
    const record = this.entries.get(this.#key(key));
    return record ? structuredClone(record) : null;
  }
  put(key: IdempotencyKey, record: IdempotencyRecord): void {
    if (this.failOn.has(record.state)) throw new Error(`store put ${record.state} failed /secret`);
    this.entries.set(this.#key(key), structuredClone(record));
  }
  release(key: IdempotencyKey, attempt: string): void {
    if (this.failOn.has("release")) throw new Error("store release failed /secret");
    if (this.entries.get(this.#key(key))?.attempt === attempt) this.entries.delete(this.#key(key));
  }
  states(): string[] { return [...this.entries.values()].map(record => record.state); }
}
