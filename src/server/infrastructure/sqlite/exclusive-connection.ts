import type { SqliteExecutionBoundary } from "./security-fence";
import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

export type ExclusiveConnectionErrorCode =
  | "busy" | "reentrant" | "in_transaction" | "unborrowed" | "released" | "expired"
  | "queue_full" | "admission_timeout" | "provider_closed" | "poisoned" | "closed"
  | "unadmitted" | "cancelled" | "draining";

/** Raised before any SQL runs; the message never contains SQL parameters. */
export class ExclusiveConnectionError extends Error {
  constructor(readonly code: ExclusiveConnectionErrorCode, message: string) {
    super(message);
    this.name = "ExclusiveConnectionError";
  }
}

/** Kysely's structural `SqliteStatement`: nothing here leads back to the owned connection. */
export interface BorrowedSqliteStatement {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<unknown>): unknown[];
  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

/** Kysely's structural `SqliteDatabase`. `close` invalidates this facade only. */
export interface BorrowedSqliteConnection {
  prepare(sql: string): BorrowedSqliteStatement;
  close(): void;
}

export interface AdmissionRequestOptions {
  /** Aborting before admission guarantees the operation never runs. */
  signal?: AbortSignal;
  /** Bounds only the wait for admission, never the admitted operation. */
  admissionTimeoutMs?: number;
  /**
   * Completion of already accepted work (finite-job persistence, terminal
   * evidence). It may queue beyond `maxQueued`, within a separate reserve, so a
   * burst of new requests cannot refuse it.
   */
  reserved?: boolean;
}

export interface ExclusiveConnectionOptions {
  /** Waiting core and provider tickets beyond this are refused instead of queued. */
  maxQueued?: number;
  /** Additional queue room reserved for `reserved` completion tickets. */
  reservedQueued?: number;
  admissionTimeoutMs?: number;
  /** A borrow still running after this is released by force and provider admission closes. */
  borrowTimeoutMs?: number;
  /**
   * `compatible` (default) lets unadmitted synchronous core SQL run while no
   * provider holds the connection, as before admission existed. `strict`
   * refuses every core statement outside an admitted operation, even when idle,
   * so a missed caller fails in tests instead of racing a provider later.
   */
  admission?: "compatible" | "strict";
  /** Ends a transaction a borrower left open. Replaceable so tests can model a failing rollback. */
  rollback?: (connection: Database.Database) => void;
}

interface Borrow { kind: "provider"; active: boolean; authorized: number; iterators: Set<IterableIterator<unknown>>; timer?: NodeJS.Timeout }
/**
 * One admitted core operation. Nested calls join it and keep it alive: it ends
 * only when its root and every joined call have settled.
 */
interface Participant {
  kind: "core"; admitted: boolean; ended: boolean; suspensions: number; pending: number;
  readmitting: Promise<void> | null; iterators: Set<IterableIterator<unknown>>;
}
/** Context of work running inside `idle`: it may not use SQL and never joins its suspended parent. */
interface Suspended { kind: "suspended" }
type Context = Borrow | Participant | Suspended;
interface Ticket {
  kind: "core" | "provider";
  grant: () => void;
  refuse: (error: ExclusiveConnectionError) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
}
type State = "open" | "provider_closed" | "poisoned" | "closed";

const fail = (code: ExclusiveConnectionErrorCode, message: string) => new ExclusiveConnectionError(code, message);
const SUSPENDED: Suspended = Object.freeze({ kind: "suspended" });
const isThenable = (value: unknown): value is PromiseLike<unknown> => !!value && typeof (value as { then?: unknown }).then === "function";

/** Point-in-time admission state for drains and tests; carries no SQL or identities. */
export interface AdmissionSnapshot {
  state: State;
  draining: boolean;
  coreActive: number;
  queuedCore: number;
  queuedProviders: number;
  providerActive: boolean;
  providerExecutions: number;
  backups: number;
}

/**
 * Sole gate in front of the controller's SQLite connection, shared by core
 * operations and an optional authentication provider. No second connection,
 * lock map or capacity counter exists elsewhere.
 *
 * - Core code keeps the synchronous `core` handle and its synchronous
 *   transactions. `runCore` admits an operation; any number of admitted core
 *   operations coexist, including across bounded awaits.
 * - `borrow` lends the connection to one provider operation exclusively. It
 *   waits until no core operation or backup is active. Every unrelated core
 *   statement, transaction, pragma and backup meanwhile fails before reaching
 *   SQLite, unless it runs inside `runControllerOperation` of that same borrow.
 * - One FIFO queue holds both kinds. Consecutive core tickets are admitted
 *   together; a queued provider is never bypassed by later core roots.
 * - `idle` releases the caller's admission while it awaits work that uses no
 *   SQL (process readiness, networking, another queue) and re-admits it after.
 *   An admitted operation must not wait for anything that itself needs
 *   admission without `idle`; every wait is bounded, so a mistake times out.
 *
 * Checks happen at execution time, so statements, iterators and transaction
 * functions prepared earlier are covered too.
 */
export class ExclusiveSqliteConnection {
  readonly core: Database.Database;
  readonly #raw: Database.Database;
  readonly #context = new AsyncLocalStorage<Context>();
  readonly #queue: Ticket[] = [];
  readonly #options: Required<ExclusiveConnectionOptions>;
  readonly #participants = new Set<Participant>();
  readonly #executions = new Set<Promise<unknown>>();
  readonly #backups = new Set<Promise<unknown>>();
  readonly #settled = new Set<() => void>();
  #strict: boolean;
  #active: Borrow | null = null;
  #coreActive = 0;
  #state: State = "open";
  #draining = false;
  #everBorrowed = false;

  constructor(connection: Database.Database, options: ExclusiveConnectionOptions = {}, private readonly boundary?: SqliteExecutionBoundary) {
    this.#raw = connection;
    this.#options = {
      maxQueued: options.maxQueued ?? 32,
      reservedQueued: options.reservedQueued ?? 128,
      admissionTimeoutMs: options.admissionTimeoutMs ?? 5_000,
      borrowTimeoutMs: options.borrowTimeoutMs ?? 30_000,
      admission: options.admission ?? "compatible",
      rollback: options.rollback ?? (database => { database.exec("ROLLBACK"); }),
    };
    this.#strict = this.#options.admission === "strict";
    this.core = coreFacade(connection, () => this.#assertCore(), iterator => this.#trackCoreIterator(iterator),
      (destination, backupOptions) => this.#backup(destination, backupOptions), boundary);
  }

  /** `open`, `provider_closed` (core usable, no more borrows), `poisoned` or `closed`. */
  get state(): State { return this.#state; }
  get borrowed(): boolean { return this.#active !== null; }
  get strict(): boolean { return this.#strict; }

  snapshot(): AdmissionSnapshot {
    return {
      state: this.#state, draining: this.#draining, coreActive: this.#coreActive,
      queuedCore: this.#queue.filter(ticket => ticket.kind === "core").length,
      queuedProviders: this.#queue.filter(ticket => ticket.kind === "provider").length,
      providerActive: this.#active !== null, providerExecutions: this.#executions.size, backups: this.#backups.size,
    };
  }

  /** Switches to strict admission once bootstrap work that predates admission has finished. Irreversible. */
  requireAdmission(): void { this.#strict = true; }

  /**
   * Runs a core operation with shared admission. Inside an admitted operation
   * it joins immediately; otherwise it waits in FIFO order behind any queued
   * provider. When admission is free now, a synchronous operation runs before
   * this call returns. Refused immediately inside a provider operation.
   */
  runCore<T>(operation: () => T | Promise<T>, options: AdmissionRequestOptions = {}): Promise<T> {
    const current = this.#context.getStore();
    if (current?.kind === "core" && this.#live(current)) return this.#execute(current, operation, options.reserved);
    return this.#root(operation, options, current);
  }

  /**
   * Runs a synchronous core operation now when admission is available without
   * waiting (inside an admitted operation, or nothing active or queued);
   * otherwise does not run it. Never queues.
   */
  tryCore<T>(operation: () => T): { ran: true; value: T } | { ran: false } {
    const current = this.#context.getStore();
    if (current?.kind === "provider") throw this.#providerContextError(current);
    const joined = current?.kind === "core" && this.#live(current) ? current : null;
    if (!joined && (this.#active || this.#queue.length || this.#state === "closed" || this.#state === "poisoned")) return { ran: false };
    const participant = joined ?? this.#participant(true);
    participant.pending++;
    try {
      this.boundary?.assert();
      const value = this.#context.run(participant, operation);
      if (isThenable(value)) throw new TypeError("tryCore operations must be synchronous.");
      return { ran: true, value };
    } finally { this.#settle(participant); }
  }

  /**
   * Starts work outside any inherited operation, e.g. a background flow
   * launched from inside an admitted one. Its later `runCore` calls take fresh
   * admissions and its `idle` calls never suspend the launching operation.
   */
  outside<T>(operation: () => T): T { return this.#context.exit(operation); }

  /** A fresh root admission that never joins an inherited operation: for detached timers, events and producers. */
  runDetached<T>(operation: () => T | Promise<T>, options: AdmissionRequestOptions = {}): Promise<T> {
    return this.#root(operation, options, this.#context.getStore());
  }

  /**
   * Awaits SQL-free work without holding admission, then re-admits the caller.
   * Outside an admitted operation it only runs `operation`. Work inside cannot
   * use SQL; nested `runCore` calls take fresh admissions. Callers recheck any
   * authority they rely on afterwards.
   *
   * Intended for sequential phases: while the caller idles, its whole operation
   * (including joined calls) is unadmitted, so a concurrently running branch of
   * the same operation must not use SQL meanwhile. Branches that idle
   * independently take their own `runDetached` admission. Every idle call
   * returns re-admitted.
   */
  async idle<T>(operation: () => Promise<T>, options: AdmissionRequestOptions = {}): Promise<T> {
    const current = this.#context.getStore();
    if (current?.kind === "provider") throw this.#providerContextError(current);
    if (current?.kind !== "core" || current.ended) return operation();
    const release = current.admitted && current.suspensions === 0;
    current.suspensions++;
    if (release) { current.admitted = false; this.#coreActive--; this.#grantNext(); }
    let result: T;
    try { result = await this.#context.run(SUSPENDED, operation); } finally {
      current.suspensions--;
      if (!current.ended && !current.admitted) await this.#readmit(current, options);
      if(!options.reserved)this.boundary?.assert();
    }
    return result;
  }

  /**
   * Runs one provider operation with exclusive use of the connection. Refuses
   * nested borrows, upgrades from an admitted core operation, entry from an
   * open core transaction and a full queue. When the operation settles with a
   * transaction still open, the connection is rolled back and provider
   * admission closes; if that rollback fails, the whole connection is poisoned.
   */
  async borrow<T>(operation: () => Promise<T>, options: AdmissionRequestOptions = {}): Promise<T> {
    const current = this.#context.getStore();
    if (current?.kind === "provider") throw current.active ? fail("reentrant", "A provider operation cannot borrow the connection again.") : this.#released();
    if (current?.kind === "core" && this.#live(current)) throw fail("reentrant", "A core operation cannot upgrade to provider access.");
    this.#assertAdmission();
    if (options.signal?.aborted) throw fail("cancelled", "The database operation was cancelled before admission.");
    // With a borrow active, an open transaction is that borrow's; this caller queues behind it.
    if (!this.#active && this.#raw.inTransaction) throw fail("in_transaction", "The connection cannot be lent from inside a transaction.");
    this.#everBorrowed = true;
    const borrow: Borrow = { kind: "provider", active: false, authorized: 0, iterators: new Set() };
    if (this.#providerAdmissible()) this.#activate(borrow);
    else await this.#enqueue("provider", () => this.#activate(borrow), options);
    let settled = false;
    // A provider may throw before returning its promise. Keep that failure on
    // the same release/rollback path as an asynchronous rejection.
    const execution = this.#context.run(borrow, async () => { if(!options.reserved)this.boundary?.assert(); return operation(); });
    this.#track(this.#executions, execution);
    const expiry = new Promise<never>((_, reject) => {
      borrow.timer = setTimeout(() => {
        if (settled) return;
        this.#release(borrow, true);
        reject(fail("expired", "The provider operation exceeded its database time limit; provider admission is closed."));
      }, this.#options.borrowTimeoutMs);
      borrow.timer.unref?.();
    });
    expiry.catch(() => undefined);
    let result: T;
    try {
      result = await Promise.race([execution, expiry]);
    } catch (error) {
      settled = true;
      clearTimeout(borrow.timer);
      execution.catch(() => undefined);
      const forced = this.#release(borrow, false);
      throw forced ?? error;
    }
    settled = true;
    clearTimeout(borrow.timer);
    const forced = this.#release(borrow, false);
    if (forced) throw forced;
    return result;
  }

  /** Runs synchronous controller-owned SQL inside the current borrow, joining its open transaction. */
  runControllerOperation<T>(operation: () => T): T {
    const borrow = this.#currentBorrow();
    borrow.authorized++;
    let result: T;
    try { result = operation(); } finally { borrow.authorized--; }
    if (isThenable(result)) throw new TypeError("Controller operations inside a borrow must be synchronous.");
    return result;
  }

  /** True only inside a provider operation that still holds its borrow; late continuations see false. */
  providerOperationActive(): boolean {
    const current = this.#context.getStore();
    return current?.kind === "provider" && current.active && current === this.#active;
  }

  /** A Kysely-compatible connection usable only inside a borrow. Closing it never touches SQLite. */
  createProviderConnection(): BorrowedSqliteConnection {
    const facade = { closed: false };
    return {
      prepare: (sql: string): BorrowedSqliteStatement => {
        if (facade.closed) throw fail("closed", "The provider connection was closed.");
        const borrow = this.#currentBorrow();
        return borrowedStatement(this.#raw.prepare(sql), () => {
          if (facade.closed) throw fail("closed", "The provider connection was closed.");
          if (!borrow.active || this.#currentBorrow() !== borrow) throw this.#released();
          this.boundary?.assert();
        }, borrow.iterators, this.boundary);
      },
      close: (): void => { facade.closed = true; },
    };
  }

  /**
   * Begins an orderly shutdown: provider admission closes and queued borrows
   * are refused. Core admission stays open so accepted work can complete.
   */
  beginDrain(): void {
    this.#draining = true;
    this.closeProviderAdmission();
  }

  /**
   * Resolves `true` once no core operation, queued ticket, backup or provider
   * execution remains, including provider work whose public promise already
   * timed out. Resolves `false` when that does not happen within `timeoutMs`;
   * the caller must then keep the connection and its ownership.
   */
  drain(timeoutMs: number): Promise<boolean> {
    return this.#waitFor(() => this.#quiescent(), timeoutMs);
  }

  /** Like `drain`, limited to provider borrows and their underlying executions. */
  drainProviders(timeoutMs: number): Promise<boolean> {
    return this.#waitFor(() => !this.#active && this.#executions.size === 0 && !this.#queue.some(ticket => ticket.kind === "provider"), timeoutMs);
  }

  #waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const done = (value: boolean) => { clearTimeout(timer); this.#settled.delete(check); resolve(value); };
      const check = () => { if (condition()) done(true); };
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      this.#settled.add(check);
    });
  }

  /** Stops admission and invalidates any borrow. The owner closes SQLite afterwards. */
  close(): void {
    if (this.#state === "closed") return;
    const active = this.#active;
    if (active) this.#release(active, true);
    this.#state = "closed";
    this.#refuseWaiters(() => fail("closed", "The database connection is closed."));
  }

  /** Closes provider admission while core work continues. Admitted borrows still finish. */
  closeProviderAdmission(): void {
    if (this.#state === "open") this.#state = "provider_closed";
    this.#refuseWaiters(() => fail("provider_closed", "Provider admission is closed."), "provider");
  }

  #quiescent(): boolean {
    return this.#coreActive === 0 && this.#participants.size === 0 && this.#queue.length === 0
      && !this.#active && this.#executions.size === 0 && this.#backups.size === 0;
  }

  #notifySettled(): void { for (const check of [...this.#settled]) check(); }

  #track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    const forget = () => { set.delete(promise); this.#grantNext(); this.#notifySettled(); };
    promise.then(forget, forget);
  }

  #live(participant: Participant): boolean { return participant.admitted && !participant.ended; }

  #providerContextError(current: Borrow): ExclusiveConnectionError {
    return current.active ? fail("reentrant", "Core admission is not available inside a provider operation.") : this.#released();
  }

  #root<T>(operation: () => T | Promise<T>, options: AdmissionRequestOptions, current: Context | undefined): Promise<T> {
    if (current?.kind === "provider") return Promise.reject(this.#providerContextError(current));
    if (this.#state === "closed") return Promise.reject(fail("closed", "The database connection is closed."));
    if (this.#state === "poisoned") return Promise.reject(fail("poisoned", "The database connection is unusable after a failed provider rollback."));
    if (options.signal?.aborted) return Promise.reject(fail("cancelled", "The database operation was cancelled before admission."));
    if (!this.#active && this.#queue.length === 0) return this.#execute(this.#participant(true), operation, options.reserved);
    const participant = this.#participant(false);
    return this.#enqueue("core", () => this.#admitCore(participant), options).then(
      () => this.#execute(participant, operation, options.reserved),
      error => { this.#endParticipant(participant); throw error; },
    );
  }

  #participant(admitted: boolean): Participant {
    const participant: Participant = { kind: "core", admitted, ended: false, suspensions: 0, pending: 0, readmitting: null, iterators: new Set() };
    this.#participants.add(participant);
    if (admitted) this.#coreActive++;
    return participant;
  }

  #admitCore(participant: Participant): void {
    if (participant.ended) return;
    participant.admitted = true;
    this.#coreActive++;
  }

  #execute<T>(participant: Participant, operation: () => T | Promise<T>, reserved=false): Promise<T> {
    participant.pending++;
    let result: T | Promise<T>;
    try { if(!reserved)this.boundary?.assert(); result = this.#context.run(participant, operation); } catch (error) {
      this.#settle(participant);
      return Promise.reject(error);
    }
    if (!isThenable(result)) {
      this.#settle(participant);
      return Promise.resolve(result);
    }
    return Promise.resolve(result).finally(() => this.#settle(participant));
  }

  /** A root or joined call settled; the participant ends with the last of them. */
  #settle(participant: Participant): void {
    participant.pending--;
    if (participant.pending === 0) this.#endParticipant(participant);
  }

  /** One re-admission per participant, shared by idle calls that finish together. */
  #readmit(participant: Participant, options: AdmissionRequestOptions): Promise<void> {
    if (this.#state === "closed") return Promise.reject(fail("closed", "The database connection is closed."));
    if (this.#state === "poisoned") return Promise.reject(fail("poisoned", "The database connection is unusable after a failed provider rollback."));
    if (participant.readmitting) return participant.readmitting;
    if (!this.#active && this.#queue.length === 0) { this.#admitCore(participant); return Promise.resolve(); }
    const readmitting = this.#enqueue("core", () => this.#admitCore(participant), options)
      .finally(() => { participant.readmitting = null; });
    participant.readmitting = readmitting;
    return readmitting;
  }

  /** Ends a participant: closes cursors it left open, then frees its share of admission. */
  #endParticipant(participant: Participant): void {
    if (participant.ended) return;
    participant.ended = true;
    for (const iterator of participant.iterators) {
      try { iterator.return?.(); } catch {
        this.#state = "poisoned";
        this.#refuseWaiters(() => fail("poisoned", "The database connection is unusable after a cursor could not be closed."));
      }
    }
    participant.iterators.clear();
    this.#participants.delete(participant);
    if (participant.admitted) { participant.admitted = false; this.#coreActive--; }
    this.#grantNext();
    this.#notifySettled();
  }

  #trackCoreIterator(iterator: IterableIterator<unknown>): (() => void) | undefined {
    const current = this.#context.getStore();
    if (current?.kind !== "core" || !this.#live(current)) return undefined;
    current.iterators.add(iterator);
    return () => { current.iterators.delete(iterator); };
  }

  #enqueue(kind: Ticket["kind"], activate: () => void, options: AdmissionRequestOptions): Promise<void> {
    const limit = this.#options.maxQueued + (options.reserved ? this.#options.reservedQueued : 0);
    if (this.#queue.length >= limit) {
      return Promise.reject(fail("queue_full", kind === "provider" ? "Too many provider operations are waiting for the database." : "Too many operations are waiting for the database."));
    }
    return new Promise<void>((resolve, reject) => {
      const signal = options.signal;
      const onAbort = () => {
        if (!remove()) return;
        reject(fail("cancelled", "The database operation was cancelled before admission."));
      };
      const remove = () => {
        const index = this.#queue.indexOf(ticket);
        if (index < 0) return false;
        this.#queue.splice(index, 1);
        ticket.detach();
        this.#grantNext();
        this.#notifySettled();
        return true;
      };
      const ticket: Ticket = {
        kind,
        grant: () => { ticket.detach(); activate(); resolve(); },
        refuse: error => { ticket.detach(); reject(error); },
        detach: () => { clearTimeout(ticket.timer); signal?.removeEventListener("abort", onAbort); },
        timer: setTimeout(() => {
          if (!remove()) return;
          reject(fail("admission_timeout", kind === "provider" ? "The database was not available to the provider in time." : "The database was not available in time."));
        }, options.admissionTimeoutMs ?? this.#options.admissionTimeoutMs),
      };
      ticket.timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(ticket);
    });
  }

  #providerAdmissible(): boolean {
    return !this.#active && this.#coreActive === 0 && this.#backups.size === 0 && this.#queue.length === 0;
  }

  #assertAdmission(): void {
    if (this.#state === "closed") throw fail("closed", "The database connection is closed.");
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (this.#state === "provider_closed") throw fail("provider_closed", "Provider admission is closed.");
  }

  #assertCore(): void {
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (!this.#strict && !this.#everBorrowed) return;
    const current = this.#context.getStore();
    const active = this.#active;
    if (current?.kind === "provider") {
      if (current === active && active.active && active.authorized > 0) return;
      if (active) throw fail("busy", "The database connection is lent to the authentication provider.");
      throw this.#released();
    }
    if (current?.kind === "core" && this.#live(current)) return;
    if (this.#strict) throw fail("unadmitted", "Database access requires an admitted operation.");
    if (active) throw fail("busy", "The database connection is lent to the authentication provider.");
  }

  #currentBorrow(): Borrow {
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (this.#state === "closed") throw fail("closed", "The database connection is closed.");
    const current = this.#context.getStore();
    if (current?.kind !== "provider") throw fail("unborrowed", "Provider SQL requires a controller borrow.");
    if (current !== this.#active || !current.active) throw this.#released();
    return current;
  }

  #released(): ExclusiveConnectionError {
    return fail("released", "A finished provider operation cannot use the database connection.");
  }

  #activate(borrow: Borrow): void {
    borrow.active = true;
    this.#active = borrow;
  }

  /** Admits consecutive core tickets together, or the head provider once core work and backups finished. */
  #grantNext(): void {
    while (this.#queue.length) {
      const head = this.#queue[0];
      if (head.kind === "core") {
        if (this.#active || this.#state === "closed" || this.#state === "poisoned") return;
        this.#queue.shift();
        head.grant();
        continue;
      }
      if (this.#state !== "open") { this.#queue.shift(); head.refuse(fail("provider_closed", "Provider admission is closed.")); continue; }
      if (this.#active || this.#coreActive > 0 || this.#backups.size > 0) return;
      this.#queue.shift();
      if (this.#raw.inTransaction) { head.refuse(fail("in_transaction", "The connection cannot be lent from inside a transaction.")); continue; }
      head.grant();
      return;
    }
  }

  #refuseWaiters(error: () => ExclusiveConnectionError, kind?: Ticket["kind"]): void {
    for (const ticket of [...this.#queue]) {
      if (kind && ticket.kind !== kind) continue;
      this.#queue.splice(this.#queue.indexOf(ticket), 1);
      ticket.refuse(error());
    }
    this.#grantNext();
    this.#notifySettled();
  }

  /** Deactivates a borrow; returns the error to report when it left a transaction open. */
  #release(borrow: Borrow, forced: boolean): ExclusiveConnectionError | undefined {
    if (this.#active !== borrow) return undefined;
    borrow.active = false;
    let error: ExclusiveConnectionError | undefined;
    // better-sqlite3 keeps a query busy even when its iterator was never read.
    // Release cursors before rollback, or SQLite cannot roll back or close.
    for (const iterator of borrow.iterators) {
      try { iterator.return?.(); } catch {
        this.#state = "poisoned";
        error = fail("poisoned", "A provider cursor could not be closed; the database connection is unusable.");
      }
    }
    borrow.iterators.clear();
    if (this.#raw.open && this.#raw.inTransaction) {
      try { this.#options.rollback(this.#raw); this.boundary?.execute(() => undefined, true); } catch { /* Transaction state checked below; the fence retains any publication failure. */ }
      if (this.#raw.inTransaction) {
        this.#state = "poisoned";
        error = fail("poisoned", "A provider transaction could not be rolled back; the database connection is unusable.");
      } else if (!error) {
        error = fail("provider_closed", "A provider operation left a transaction open; it was rolled back and provider admission is closed.");
      }
    }
    this.#active = null;
    if ((error || forced) && this.#state === "open") this.#state = "provider_closed";
    if (this.#state === "poisoned") this.#refuseWaiters(() => fail("poisoned", "The database connection is unusable after a failed provider rollback."));
    else if (this.#state !== "open") this.#refuseWaiters(() => fail(this.#state === "closed" ? "closed" : "provider_closed", "Provider admission is closed."), "provider");
    else this.#grantNext();
    this.#notifySettled();
    return error;
  }

  #backup(destination: string, options?: Database.BackupOptions): Promise<Database.BackupMetadata> {
    this.#assertCore();
    if (this.#active) throw fail("busy", "The database connection is lent to the authentication provider.");
    if (this.#state === "closed") throw fail("closed", "The database connection is closed.");
    // The hold lasts until the driver's promise settles, not until the caller stops waiting.
    this.boundary?.assert();
    const pending = this.#raw.backup(destination, options);
    this.#track(this.#backups, pending);
    return pending;
  }
}

function borrowedStatement(statement: Database.Statement, check: () => void, iterators: Set<IterableIterator<unknown>>, boundary?: SqliteExecutionBoundary): BorrowedSqliteStatement {
  const execute = <T>(operation: () => T) => boundary ? boundary.execute(operation, statement.readonly) : operation();
  return {
    reader: statement.reader,
    all(parameters) { check(); return execute(() => statement.all(...parameters)); },
    run(parameters) { check(); return execute(() => statement.run(...parameters)); },
    iterate(parameters) {
      check();
      if (boundary && !statement.readonly) throw fail("unadmitted", "Mutating SQL iterators are unavailable.");
      boundary?.assert();
      const iterator = statement.iterate(...parameters);
      iterators.add(iterator);
      return guardedIterator(iterator, check, () => { iterators.delete(iterator); });
    },
  };
}

function guardedIterator<T>(iterator: IterableIterator<T>, check: () => void, finished: () => void = () => undefined): IterableIterator<T> {
  const guarded: IterableIterator<T> = {
    next() {
      try {
        check();
        const result = iterator.next();
        if (result.done) finished();
        return result;
      } catch (error) {
        try { iterator.return?.(); finished(); } catch { /* retained for borrow cleanup */ }
        throw error;
      }
    },
    return(value?: unknown) {
      const result = iterator.return?.(value) ?? { done: true, value: undefined as T };
      finished();
      return result;
    },
    [Symbol.iterator]() { return guarded; },
  };
  return guarded;
}

/**
 * The synchronous handle core code receives. `statement.database` and
 * `transaction.database` lead back here, never to the raw connection.
 */
function coreFacade(
  raw: Database.Database,
  assert: () => void,
  track: (iterator: IterableIterator<unknown>) => (() => void) | undefined,
  backup: (destination: string, options?: Database.BackupOptions) => Promise<Database.BackupMetadata>,
  boundary?: SqliteExecutionBoundary,
): Database.Database {
  const execute = <T>(operation: () => T, readonly = false) => boundary ? boundary.execute(operation, readonly) : operation();
  const checked = assert;
  assert = () => { checked(); boundary?.assert(); };
  const facade = {
    get memory() { return raw.memory; },
    get readonly() { return raw.readonly; },
    get name() { return raw.name; },
    get open() { return raw.open; },
    get inTransaction() { return raw.inTransaction; },
    prepare(source: string) { assert(); return coreStatement(raw.prepare(source), facade as unknown as Database.Database, assert, track, boundary); },
    transaction(fn: (...parameters: unknown[]) => unknown) {
      assert();
      const inner = raw.transaction(fn);
      const guard = (variant: (...parameters: unknown[]) => unknown) => function guardedTransaction(this: unknown, ...parameters: unknown[]) {
        assert();
        return execute(() => variant.apply(this, parameters), true);
      };
      const variants = { default: guard(inner.default), deferred: guard(inner.deferred), immediate: guard(inner.immediate), exclusive: guard(inner.exclusive) };
      const properties = {
        default: { value: variants.default }, deferred: { value: variants.deferred },
        immediate: { value: variants.immediate }, exclusive: { value: variants.exclusive },
        database: { value: facade, enumerable: true },
      };
      for (const variant of Object.values(variants)) Object.defineProperties(variant, properties);
      return variants.default;
    },
    exec(source: string) { assert(); execute(() => raw.exec(source)); return facade; },
    pragma(source: string, options?: Database.PragmaOptions) { assert(); return raw.pragma(source, options); },
    function(...parameters: unknown[]) { assert(); (raw.function as (...values: unknown[]) => unknown)(...parameters); return facade; },
    aggregate(name: string, options: Database.AggregateOptions) { assert(); raw.aggregate(name, options); return facade; },
    loadExtension(path: string) { assert(); raw.loadExtension(path); return facade; },
    close() { assert(); raw.close(); return facade; },
    defaultSafeIntegers(...parameters: [boolean?]) { assert(); raw.defaultSafeIntegers(...parameters); return facade; },
    backup,
    table(name: string, options: Parameters<Database.Database["table"]>[1]) { assert(); raw.table(name, options); return facade; },
    unsafeMode(...parameters: [boolean?]) { assert(); raw.unsafeMode(...parameters); return facade; },
    serialize(options?: Database.SerializeOptions) { assert(); return raw.serialize(options); },
  };
  return facade as unknown as Database.Database;
}

function coreStatement(
  statement: Database.Statement,
  database: Database.Database,
  assert: () => void,
  track: (iterator: IterableIterator<unknown>) => (() => void) | undefined,
  boundary?: SqliteExecutionBoundary,
): Database.Statement {
  const execute = <T>(operation: () => T) => boundary ? boundary.execute(operation, statement.readonly) : operation();
  const wrapper = {
    get database() { return database; },
    get source() { return statement.source; },
    get reader() { return statement.reader; },
    get readonly() { return statement.readonly; },
    get busy() { return statement.busy; },
    run(...parameters: unknown[]) { assert(); return execute(() => statement.run(...parameters)); },
    get(...parameters: unknown[]) { assert(); return execute(() => statement.get(...parameters)); },
    all(...parameters: unknown[]) { assert(); return execute(() => statement.all(...parameters)); },
    iterate(...parameters: unknown[]) {
      assert();
      if (boundary && !statement.readonly) throw fail("unadmitted", "Mutating SQL iterators are unavailable.");
      // An admitted operation's cursors close when it ends, before a provider can be admitted.
      const iterator = statement.iterate(...parameters) as IterableIterator<unknown>;
      return guardedIterator(iterator, assert, track(iterator));
    },
    pluck(...parameters: [boolean?]) { statement.pluck(...parameters); return wrapper; },
    expand(...parameters: [boolean?]) { statement.expand(...parameters); return wrapper; },
    raw(...parameters: [boolean?]) { statement.raw(...parameters); return wrapper; },
    bind(...parameters: unknown[]) { statement.bind(...parameters); return wrapper; },
    columns() { return statement.columns(); },
    safeIntegers(...parameters: [boolean?]) { statement.safeIntegers(...parameters); return wrapper; },
  };
  return wrapper as unknown as Database.Statement;
}
