import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

export type ExclusiveConnectionErrorCode =
  | "busy" | "reentrant" | "in_transaction" | "unborrowed" | "released" | "expired"
  | "queue_full" | "admission_timeout" | "provider_closed" | "poisoned" | "closed";

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

export interface ExclusiveConnectionOptions {
  /** Waiting borrowers beyond this are refused instead of queued. */
  maxQueued?: number;
  admissionTimeoutMs?: number;
  /** A borrow still running after this is released by force and provider admission closes. */
  borrowTimeoutMs?: number;
  /** Ends a transaction a borrower left open. Replaceable so tests can model a failing rollback. */
  rollback?: (connection: Database.Database) => void;
}

interface Borrow { active: boolean; authorized: number; iterators: Set<IterableIterator<unknown>>; timer?: NodeJS.Timeout }
interface Waiter { borrow: Borrow; grant: () => void; refuse: (error: ExclusiveConnectionError) => void; timer: NodeJS.Timeout }
type State = "open" | "provider_closed" | "poisoned" | "closed";

const fail = (code: ExclusiveConnectionErrorCode, message: string) => new ExclusiveConnectionError(code, message);

/**
 * Sole gate in front of the controller's SQLite connection. Core code keeps
 * using the synchronous `core` handle. An authentication provider may borrow
 * the connection exclusively for one asynchronous operation; meanwhile every
 * core statement, transaction, pragma and backup fails fast with `busy` before
 * reaching SQLite, unless it runs inside `runControllerOperation` of that same
 * borrow. Checks happen at execution time, so statements, iterators and
 * transaction functions prepared earlier are covered too.
 *
 * Without a borrow the gate only adds a state check per call.
 */
export class ExclusiveSqliteConnection {
  readonly core: Database.Database;
  readonly #raw: Database.Database;
  readonly #context = new AsyncLocalStorage<Borrow>();
  readonly #queue: Waiter[] = [];
  readonly #options: Required<ExclusiveConnectionOptions>;
  #active: Borrow | null = null;
  #holds = 0;
  #state: State = "open";
  #everBorrowed = false;

  constructor(connection: Database.Database, options: ExclusiveConnectionOptions = {}) {
    this.#raw = connection;
    this.#options = {
      maxQueued: options.maxQueued ?? 32,
      admissionTimeoutMs: options.admissionTimeoutMs ?? 5_000,
      borrowTimeoutMs: options.borrowTimeoutMs ?? 30_000,
      rollback: options.rollback ?? (database => { database.exec("ROLLBACK"); }),
    };
    this.core = coreFacade(connection, () => this.#assertCore(), (destination, backupOptions) => this.#backup(destination, backupOptions));
  }

  /** `open`, `provider_closed` (core usable, no more borrows), `poisoned` or `closed`. */
  get state(): State { return this.#state; }
  get borrowed(): boolean { return this.#active !== null; }

  /**
   * Runs one provider operation with exclusive use of the connection. Refuses
   * nested borrows, entry from an open core transaction and a full queue. When
   * the operation settles with a transaction still open, the connection is
   * rolled back and provider admission closes; if that rollback fails, the
   * whole connection is poisoned.
   */
  async borrow<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#context.getStore();
    if (current) throw current.active ? fail("reentrant", "A provider operation cannot borrow the connection again.") : this.#released();
    this.#assertAdmission();
    // With a borrow active, an open transaction is that borrow's; this caller queues behind it.
    if (!this.#active && this.#raw.inTransaction) throw fail("in_transaction", "The connection cannot be lent from inside a transaction.");
    if (this.#queue.length >= this.#options.maxQueued) throw fail("queue_full", "Too many provider operations are waiting for the database.");
    this.#everBorrowed = true;
    const borrow: Borrow = { active: false, authorized: 0, iterators: new Set() };
    await this.#admit(borrow);
    let settled = false;
    // A provider may throw before returning its promise. Keep that failure on
    // the same release/rollback path as an asynchronous rejection.
    const execution = this.#context.run(borrow, async () => operation());
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
    if (result && typeof (result as { then?: unknown }).then === "function") throw new TypeError("Controller operations inside a borrow must be synchronous.");
    return result;
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
        }, borrow.iterators);
      },
      close: (): void => { facade.closed = true; },
    };
  }

  /** Stops admission and invalidates any borrow. The owner closes SQLite afterwards. */
  close(): void {
    if (this.#state === "closed") return;
    const active = this.#active;
    if (active) this.#release(active, true);
    this.#state = "closed";
    this.#refuseWaiters(fail("closed", "The database connection is closed."));
  }

  /** Closes provider admission while core work continues. Admitted borrows still finish. */
  closeProviderAdmission(): void {
    if (this.#state === "open") this.#state = "provider_closed";
    this.#refuseWaiters(fail("provider_closed", "Provider admission is closed."));
  }

  #assertAdmission(): void {
    if (this.#state === "closed") throw fail("closed", "The database connection is closed.");
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (this.#state === "provider_closed") throw fail("provider_closed", "Provider admission is closed.");
  }

  #assertCore(): void {
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (!this.#everBorrowed) return;
    const current = this.#context.getStore();
    const active = this.#active;
    if (active) {
      if (current === active && active.active && active.authorized > 0) return;
      throw fail("busy", "The database connection is lent to the authentication provider.");
    }
    if (current) throw this.#released();
  }

  #currentBorrow(): Borrow {
    if (this.#state === "poisoned") throw fail("poisoned", "The database connection is unusable after a failed provider rollback.");
    if (this.#state === "closed") throw fail("closed", "The database connection is closed.");
    const current = this.#context.getStore();
    if (!current) throw fail("unborrowed", "Provider SQL requires a controller borrow.");
    if (current !== this.#active || !current.active) throw this.#released();
    return current;
  }

  #released(): ExclusiveConnectionError {
    return fail("released", "A finished provider operation cannot use the database connection.");
  }

  #admit(borrow: Borrow): Promise<void> {
    if (!this.#active && this.#holds === 0 && this.#queue.length === 0) {
      this.#activate(borrow);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        borrow,
        grant: () => { clearTimeout(waiter.timer); resolve(); },
        refuse: error => { clearTimeout(waiter.timer); reject(error); },
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(fail("admission_timeout", "The database was not available to the provider in time."));
        }, this.#options.admissionTimeoutMs),
      };
      waiter.timer.unref?.();
      this.#queue.push(waiter);
    });
  }

  #activate(borrow: Borrow): void {
    borrow.active = true;
    this.#active = borrow;
  }

  #grantNext(): void {
    if (this.#active || this.#holds > 0 || this.#state !== "open") return;
    const next = this.#queue.shift();
    if (!next) return;
    if (this.#raw.inTransaction) {
      next.refuse(fail("in_transaction", "The connection cannot be lent from inside a transaction."));
      return this.#grantNext();
    }
    this.#activate(next.borrow);
    next.grant();
  }

  #refuseWaiters(error: ExclusiveConnectionError): void {
    for (const waiter of this.#queue.splice(0)) waiter.refuse(error);
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
      try { this.#options.rollback(this.#raw); } catch { /* checked below */ }
      if (this.#raw.inTransaction) {
        this.#state = "poisoned";
        error = fail("poisoned", "A provider transaction could not be rolled back; the database connection is unusable.");
      } else if (!error) {
        error = fail("provider_closed", "A provider operation left a transaction open; it was rolled back and provider admission is closed.");
      }
    }
    this.#active = null;
    if ((error || forced) && this.#state === "open") this.#state = "provider_closed";
    if (this.#state !== "open") this.#refuseWaiters(fail(this.#state === "poisoned" ? "poisoned" : "provider_closed", "Provider admission is closed."));
    else this.#grantNext();
    return error;
  }

  #backup(destination: string, options?: Database.BackupOptions): Promise<Database.BackupMetadata> {
    this.#assertCore();
    if (this.#active) throw fail("busy", "The database connection is lent to the authentication provider.");
    this.#holds++;
    let pending: Promise<Database.BackupMetadata>;
    try { pending = this.#raw.backup(destination, options); } catch (error) { this.#holds--; this.#grantNext(); throw error; }
    return pending.finally(() => { this.#holds--; this.#grantNext(); });
  }
}

function borrowedStatement(statement: Database.Statement, check: () => void, iterators: Set<IterableIterator<unknown>>): BorrowedSqliteStatement {
  return {
    reader: statement.reader,
    all(parameters) { check(); return statement.all(...parameters); },
    run(parameters) { check(); return statement.run(...parameters); },
    iterate(parameters) {
      check();
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
  backup: (destination: string, options?: Database.BackupOptions) => Promise<Database.BackupMetadata>,
): Database.Database {
  const facade = {
    get memory() { return raw.memory; },
    get readonly() { return raw.readonly; },
    get name() { return raw.name; },
    get open() { return raw.open; },
    get inTransaction() { return raw.inTransaction; },
    prepare(source: string) { assert(); return coreStatement(raw.prepare(source), facade as unknown as Database.Database, assert); },
    transaction(fn: (...parameters: unknown[]) => unknown) {
      assert();
      const inner = raw.transaction(fn);
      const guard = (variant: (...parameters: unknown[]) => unknown) => function guardedTransaction(this: unknown, ...parameters: unknown[]) {
        assert();
        return variant.apply(this, parameters);
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
    exec(source: string) { assert(); raw.exec(source); return facade; },
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

function coreStatement(statement: Database.Statement, database: Database.Database, assert: () => void): Database.Statement {
  const wrapper = {
    get database() { return database; },
    get source() { return statement.source; },
    get reader() { return statement.reader; },
    get readonly() { return statement.readonly; },
    get busy() { return statement.busy; },
    run(...parameters: unknown[]) { assert(); return statement.run(...parameters); },
    get(...parameters: unknown[]) { assert(); return statement.get(...parameters); },
    all(...parameters: unknown[]) { assert(); return statement.all(...parameters); },
    iterate(...parameters: unknown[]) { assert(); return guardedIterator(statement.iterate(...parameters), assert); },
    pluck(...parameters: [boolean?]) { statement.pluck(...parameters); return wrapper; },
    expand(...parameters: [boolean?]) { statement.expand(...parameters); return wrapper; },
    raw(...parameters: [boolean?]) { statement.raw(...parameters); return wrapper; },
    bind(...parameters: unknown[]) { statement.bind(...parameters); return wrapper; },
    columns() { return statement.columns(); },
    safeIntegers(...parameters: [boolean?]) { statement.safeIntegers(...parameters); return wrapper; },
  };
  return wrapper as unknown as Database.Statement;
}
