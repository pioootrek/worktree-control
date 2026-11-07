import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup } from "@/server/controller-backup";
import { ExclusiveConnectionError, type ExclusiveConnectionOptions } from "./exclusive-connection";
import { SqliteStateStore } from "./sqlite-state-store";

const roots: string[] = [];
const stores: SqliteStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options?: ExclusiveConnectionOptions) {
  const root = mkdtempSync(join(tmpdir(), "exclusive-connection-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path, undefined, options); stores.push(store);
  const storage = store.authenticationProviderStorage();
  const core = (store as unknown as { database: Database.Database }).database;
  const project = (name: string, port: number) => store.addProject({ name, repositoryPath: join(root, name), port, executable: "node", args: ["dev"] });
  return { root, path, store, storage, core, project };
}
const committed = <T>(path: string, read: (db: Database.Database) => T) => {
  const db = new Database(path, { readonly: true }); try { return read(db); } finally { db.close(); }
};
const providerUsers = (path: string) => committed(path, db => (db.prepare('SELECT count(*) n FROM "authentication_ba_user"').get() as { n: number }).n);
const insertUser = 'INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES (?,?,?,0,?,?)';
const userValues = (id: string) => [id, "Fixture", `${id}@fixture.invalid`, "now", "now"];
function code(operation: () => unknown): string | undefined {
  try { operation(); } catch (error) { return error instanceof ExclusiveConnectionError ? error.code : `other: ${String(error)}`; }
  return undefined;
}
async function asyncCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try { await operation(); } catch (error) { return error instanceof ExclusiveConnectionError ? error.code : `other: ${String(error)}`; }
  return undefined;
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe("exclusive provider borrow of the controller connection", () => {
  it.each([false, true])("never invokes a provider callback with an already aborted signal (contended: %s)", async contended => {
    const f = fixture();
    const entered = gate(), release = gate();
    const held = contended ? f.storage.borrow(async () => { entered.open(); await release.opened; }) : Promise.resolve();
    if (contended) await entered.opened;
    const abort = new AbortController(); abort.abort();
    let invoked = false;
    const pending = asyncCode(() => f.storage.borrow(async () => { invoked = true; }, { signal: abort.signal }));
    release.open();
    try {
      expect(await pending).toBe("cancelled");
      expect(invoked).toBe(false);
    } finally { release.open(); await held; }
    await expect(f.storage.borrow(async () => "still usable")).resolves.toBe("still usable");
  });

  it("preserves omitted boolean arguments on core database and statement methods", () => {
    const f = fixture();
    expect(f.core.prepare("SELECT 1 n").pluck().get()).toBe(1);
    expect(f.core.prepare("SELECT 1 n").expand().get()).toEqual({ $: { n: 1 } });
    expect(f.core.prepare("SELECT 1 n").raw().get()).toEqual([1]);
    expect(f.core.prepare("SELECT 1 n").safeIntegers().get()).toEqual({ n: 1n });
    expect(f.core.defaultSafeIntegers()).toBe(f.core);
    expect(f.core.prepare("SELECT 1 n").get()).toEqual({ n: 1n });
    f.core.defaultSafeIntegers(false);
    expect(f.core.prepare("SELECT 1 n").get()).toEqual({ n: 1 });
    expect(f.core.unsafeMode()).toBe(f.core);
    f.core.unsafeMode(false);
    // Explicit undefined is not an omitted argument in the pinned driver.
    expect(() => f.core.prepare("SELECT 1").pluck(undefined)).toThrow(TypeError);
  });

  it.each(["return", "unstarted", "throw", "transaction", "expire", "close"] as const)("closes abandoned provider iterators on %s", async outcome => {
    const f = fixture({ borrowTimeoutMs: 100 });
    const connection = f.storage.createProviderConnection();
    const paused = gate(), resume = gate();
    let iterator: IterableIterator<unknown> | undefined;
    const borrowed = f.storage.borrow(async () => {
      if (outcome === "transaction") {
        connection.prepare("BEGIN").run([]);
        connection.prepare(insertUser).run(userValues("rollback-with-iterator"));
      }
      iterator = connection.prepare("SELECT 1 UNION ALL SELECT 2").iterate([]);
      if (outcome !== "unstarted") iterator.next();
      paused.open();
      if (outcome === "expire" || outcome === "close") await resume.opened;
      if (outcome === "throw") throw new Error("fixture failure");
    });
    // Observe rejection immediately, including forced timeout/closure paths.
    const result = borrowed.then(() => undefined, (error: unknown) => error);
    await paused.opened;
    if (outcome === "close") {
      f.store.close();
      resume.open();
    }
    const failure = await result;
    resume.open();
    if (outcome === "transaction") expect(failure).toMatchObject({ code: "provider_closed" });
    if (outcome === "expire") expect(failure).toMatchObject({ code: "expired" });
    if (outcome === "throw") expect(failure).toMatchObject({ message: "fixture failure" });
    if (outcome !== "close") {
      expect(providerUsers(f.path)).toBe(0);
      f.project("after-iterator", 3510);
      expect(() => iterator!.next()).toThrow();
      f.store.close();
    }
    stores.splice(stores.indexOf(f.store), 1);
    expect(f.core.open).toBe(false);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    const reopened = new SqliteStateStore(f.path); stores.push(reopened);
    expect(reopened.schemaVersion()).toBe(48);
  });

  it.each([false, true])("releases a synchronously throwing provider callback (open transaction: %s)", async (openTransaction) => {
    const f = fixture();
    const kept = f.project("kept", 3501);
    const connection = f.storage.createProviderConnection();
    const failure = new Error("provider failed before returning a promise");
    const result = f.storage.borrow(() => {
      if (openTransaction) {
        connection.prepare("BEGIN").run([]);
        connection.prepare(insertUser).run(userValues("rolled-back"));
      }
      throw failure;
    });
    if (openTransaction) await expect(result).rejects.toMatchObject({ code: "provider_closed" });
    else await expect(result).rejects.toBe(failure);
    expect(f.store.getProject(kept.id)?.name).toBe("kept");
    expect(providerUsers(f.path)).toBe(0);
    if (openTransaction) await expect(f.storage.borrow(async () => undefined)).rejects.toMatchObject({ code: "provider_closed" });
    else await expect(f.storage.borrow(async () => "usable")).resolves.toBe("usable");
  });

  it("exposes no path from core or borrowed handles back to the raw connection", async () => {
    const f = fixture();
    const statement = f.core.prepare("SELECT 1");
    expect(statement.database).toBe(f.core);
    // better-sqlite3 sets `database` on transaction functions; its types omit it.
    const transaction = f.core.transaction(() => 1) as ReturnType<Database.Database["transaction"]> & { database: unknown; immediate: { database: unknown } };
    expect(transaction.database).toBe(f.core);
    expect(transaction.immediate.database).toBe(f.core);
    expect(transaction()).toBe(1);
    const connection = f.storage.createProviderConnection();
    expect(Object.keys(connection).sort()).toEqual(["close", "prepare"]);
    await f.storage.borrow(async () => { expect(Object.keys(connection.prepare("SELECT 1")).sort()).toEqual(["all", "iterate", "reader", "run"]); });
  });

  it("refuses every unrelated core access while a provider transaction holds an uncommitted write, and its rollback keeps earlier core work", async () => {
    const f = fixture();
    const kept = f.project("kept", 3501);
    const previouslyPrepared = f.core.prepare("SELECT count(*) n FROM projects");
    const previousTransaction = f.core.transaction(() => f.core.prepare("SELECT 1").get());
    const connection = f.storage.createProviderConnection();
    const paused = gate(), resume = gate();
    const borrowed = f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("provider-user"));
      paused.open();
      await resume.opened;
      connection.prepare("ROLLBACK").run([]);
    });
    await paused.opened;
    const refusals = {
      read: code(() => f.store.getProject(kept.id)),
      write: code(() => f.project("blocked", 3502)),
      prepared: code(() => previouslyPrepared.get()),
      transaction: code(() => previousTransaction()),
      newTransaction: code(() => f.core.transaction(() => undefined).immediate()),
      pragma: code(() => f.core.pragma("user_version")),
      exec: code(() => f.core.exec("SELECT 1")),
      backup: await asyncCode(() => f.store.backup(join(f.root, "blocked-backup.sqlite3"))),
    };
    expect(refusals).toEqual({ read: "busy", write: "busy", prepared: "busy", transaction: "busy", newTransaction: "busy", pragma: "busy", exec: "busy", backup: "busy" });
    const queued = f.storage.borrow(async () => "queued borrow ran after release");
    resume.open();
    await borrowed;
    expect(await queued).toBe("queued borrow ran after release");
    expect(f.store.getProject(kept.id)?.name).toBe("kept");
    expect(f.store.listProjects().map(project => project.name)).toEqual(["kept"]);
    expect(providerUsers(f.path)).toBe(0);
    expect(existsSync(join(f.root, "blocked-backup.sqlite3"))).toBe(false);
  });

  it("fails closed while a core iterator is open, and the guard closes that stale iterator", async () => {
    const f = fixture();
    f.project("iterated", 3507);
    const iterator = f.core.prepare("SELECT id FROM projects").iterate();
    expect(iterator.next().done).toBe(false);
    const connection = f.storage.createProviderConnection();
    await f.storage.borrow(async () => {
      expect(() => connection.prepare("BEGIN").run([])).toThrow(/busy executing a query/);
      expect(code(() => iterator.next())).toBe("busy");
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("after-iterator"));
      connection.prepare("COMMIT").run([]);
    });
    expect(providerUsers(f.path)).toBe(1);
    expect(f.store.listProjects()).toHaveLength(1);
  });

  it("joins controller-owned SQL to the borrow's open transaction only through runControllerOperation", async () => {
    const f = fixture();
    const connection = f.storage.createProviderConnection();
    const subjects = f.storage.subjects("better-auth");
    for (const outcome of ["ROLLBACK", "COMMIT"] as const) {
      await f.storage.borrow(async () => {
        connection.prepare("BEGIN").run([]);
        connection.prepare(insertUser).run(userValues(`user-${outcome}`));
        expect(code(() => subjects.find(`user-${outcome}`))).toBe("busy");
        f.storage.runControllerOperation(() => subjects.record("authentication.provider.account_provisioned", { subject: `user-${outcome}`, principalId: "installation", actor: "test" }));
        connection.prepare(outcome).run([]);
      });
    }
    const events = committed(f.path, db => db.prepare("SELECT event_type, details_json FROM controller_audit_events WHERE event_type LIKE 'authentication.provider.%'").all());
    expect(events).toEqual([{ event_type: "authentication.provider.account_provisioned", details_json: JSON.stringify({ providerId: "better-auth", subject: "user-COMMIT", principalId: "installation" }) }]);
    expect(code(() => f.storage.runControllerOperation(() => 1))).toBe("unborrowed");
  });

  it("rejects escaped statements, detached continuations and facade use outside the borrow", async () => {
    const f = fixture();
    const connection = f.storage.createProviderConnection();
    let escaped: ReturnType<typeof connection.prepare> | undefined;
    let detached: Promise<string | undefined> | undefined;
    await f.storage.borrow(async () => {
      escaped = connection.prepare("SELECT 1 one");
      expect(escaped.all([])).toEqual([{ one: 1 }]);
      const later = gate();
      detached = later.opened.then(() => code(() => f.store.listProjects()));
      setTimeout(later.open, 5);
    });
    expect(code(() => escaped!.all([]))).toBe("released");
    expect(code(() => connection.prepare("SELECT 1"))).toBe("unborrowed");
    expect(await detached).toBe("released");
    expect(f.store.listProjects()).toEqual([]);
    connection.close();
    expect(code(() => connection.prepare("SELECT 1"))).toBe("closed");
    f.project("still-usable", 3503);
    expect(f.store.listProjects()).toHaveLength(1);
  });

  it("refuses reentrant borrows and entry from an open core transaction", async () => {
    const f = fixture();
    expect(await asyncCode(() => f.storage.borrow(() => f.storage.borrow(async () => undefined)))).toBe("reentrant");
    let inside: Promise<unknown> | undefined;
    f.core.transaction(() => { inside = f.storage.borrow(async () => undefined); })();
    expect(await asyncCode(() => inside!)).toBe("in_transaction");
    await f.storage.borrow(async () => undefined);
  });

  it("rolls back a transaction left open, closes provider admission and keeps core usable", async () => {
    const f = fixture();
    const connection = f.storage.createProviderConnection();
    expect(await asyncCode(() => f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("abandoned"));
    }))).toBe("provider_closed");
    expect(providerUsers(f.path)).toBe(0);
    expect(await asyncCode(() => f.storage.borrow(async () => undefined))).toBe("provider_closed");
    f.project("after-abandon", 3504);
    expect(f.store.listProjects()).toHaveLength(1);
  });

  it("rolls back an async failure after a write when the borrower does not", async () => {
    const f = fixture();
    const connection = f.storage.createProviderConnection();
    const error = await f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("failed"));
      await Promise.resolve();
      throw new Error("library failure");
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ExclusiveConnectionError);
    expect(providerUsers(f.path)).toBe(0);
  });

  it("poisons the connection when a left-open transaction cannot be rolled back, and the owner still closes cleanly", async () => {
    const f = fixture({ rollback: () => { throw new Error("rollback failure"); } });
    const connection = f.storage.createProviderConnection();
    expect(await asyncCode(() => f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("stuck"));
    }))).toBe("poisoned");
    expect(code(() => f.store.listProjects())).toBe("poisoned");
    expect(await asyncCode(() => f.storage.borrow(async () => undefined))).toBe("poisoned");
    stores.splice(stores.indexOf(f.store), 1); f.store.close();
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    const reopened = new SqliteStateStore(f.path); stores.push(reopened);
    expect(providerUsers(f.path)).toBe(0);
    expect(reopened.schemaVersion()).toBe(48);
  });

  it("waits for a running core backup before lending the connection", async () => {
    const f = fixture();
    f.project("backed-up", 3505);
    const order: string[] = [];
    const backup = f.store.backup(join(f.root, "paged.sqlite3"), { progress: () => { order.push("page"); return 1; } });
    const borrowed = f.storage.borrow(async () => { order.push("borrow"); });
    await Promise.all([backup, borrowed]);
    expect(order.filter(entry => entry === "page").length).toBeGreaterThan(5);
    expect(order.at(-1)).toBe("borrow");
    await createControllerBackup(f.store, join(f.root, "verified"), { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
  });

  it("bounds the admission queue, admission wait and borrow duration", async () => {
    const f = fixture({ maxQueued: 1, admissionTimeoutMs: 50, borrowTimeoutMs: 100 });
    const hold = gate();
    const first = f.storage.borrow(() => hold.opened);
    const queued = f.storage.borrow(async () => undefined);
    expect(await asyncCode(() => f.storage.borrow(async () => undefined))).toBe("queue_full");
    expect(await asyncCode(() => queued)).toBe("admission_timeout");
    expect(await asyncCode(() => first)).toBe("expired");
    hold.open();
    expect(await asyncCode(() => f.storage.borrow(async () => undefined))).toBe("provider_closed");
    f.project("after-expiry", 3506);
  });

  it("invalidates an active borrow when the store closes and releases the ownership lock", async () => {
    const f = fixture();
    const connection = f.storage.createProviderConnection();
    const paused = gate(), resume = gate();
    const borrowed = f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("closing"));
      paused.open();
      await resume.opened;
      connection.prepare("COMMIT").run([]);
    });
    await paused.opened;
    stores.splice(stores.indexOf(f.store), 1); f.store.close();
    resume.open();
    expect(await asyncCode(() => borrowed)).toBe("closed");
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    expect(providerUsers(f.path)).toBe(0);
  });
});

describe("shared core admission on the same connection gate", () => {
  const admission = (store: SqliteStateStore) => store.admission;
  const snapshot = (store: SqliteStateStore) => store.admissionSnapshot();
  const raw = (f: ReturnType<typeof fixture>) => f.storage.createProviderConnection();
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));

  it("keeps the synchronous no-provider path compatible and runs an admissible operation before returning", async () => {
    const f = fixture();
    f.project("unadmitted", 3601);
    let ran = false;
    const pending = admission(f.store).run(() => { ran = true; return f.store.listProjects().length; });
    expect(ran).toBe(true);
    expect(await pending).toBe(1);
    expect(snapshot(f.store)).toMatchObject({ coreActive: 0, queuedCore: 0, queuedProviders: 0 });
  });

  it("refuses unadmitted SQL in strict mode even while idle, including continuations of finished operations", async () => {
    const f = fixture({ admission: "strict" });
    expect(code(() => f.store.listProjects())).toBe("unadmitted");
    let later: Promise<string | undefined> | undefined;
    await admission(f.store).run(async () => {
      f.project("admitted", 3602);
      await Promise.resolve();
      expect(f.store.listProjects()).toHaveLength(1);
      later = tick().then(() => code(() => f.store.listProjects()));
    });
    expect(await later).toBe("unadmitted");
    expect(await admission(f.store).detached(() => f.store.listProjects().length)).toBe(1);
  });

  it("holds core work behind a paused provider transaction, runs it once after rollback and keeps earlier core state", async () => {
    const f = fixture({ admission: "strict" });
    const connection = raw(f);
    await admission(f.store).run(() => f.project("earlier", 3603));
    const paused = gate(), resume = gate();
    const borrowed = f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("paused"));
      paused.open();
      await resume.opened;
      connection.prepare("ROLLBACK").run([]);
    });
    await paused.opened;
    let runs = 0;
    const read = admission(f.store).run(() => { runs++; return f.store.listProjects().map(project => project.name); });
    const write = admission(f.store).run(() => { runs++; return f.project("queued", 3604).name; });
    await tick();
    expect(runs).toBe(0);
    expect(snapshot(f.store)).toMatchObject({ providerActive: true, queuedCore: 2 });
    resume.open();
    await borrowed;
    expect(await read).toEqual(["earlier"]);
    expect(await write).toBe("queued");
    expect(runs).toBe(2);
    expect(providerUsers(f.path)).toBe(0);
    expect(await admission(f.store).run(() => f.store.listProjects().map(project => project.name))).toEqual(["earlier", "queued"]);
  });

  it("admits a queued provider before later core roots, batches consecutive core tickets and never starves either", async () => {
    const f = fixture({ admission: "strict" });
    const order: string[] = [];
    const firstCore = gate();
    const holding = admission(f.store).run(async () => { order.push("core-1"); await firstCore.opened; order.push("core-1-end"); });
    const provider = f.storage.borrow(async () => { order.push("provider"); await tick(); order.push("provider-end"); });
    const later = [1, 2].map(index => admission(f.store).run(() => { order.push(`core-later-${index}`); }));
    const joined = admission(f.store).run(async () => undefined);
    await tick();
    expect(order).toEqual(["core-1"]);
    expect(snapshot(f.store)).toMatchObject({ coreActive: 1, queuedProviders: 1, queuedCore: 3 });
    firstCore.open();
    await Promise.all([holding, provider, ...later, joined]);
    expect(order).toEqual(["core-1", "core-1-end", "provider", "provider-end", "core-later-1", "core-later-2"]);
    expect(snapshot(f.store)).toMatchObject({ coreActive: 0, queuedCore: 0, queuedProviders: 0 });
  });

  it("joins nested calls inside an admitted operation instead of queueing behind a waiting provider", async () => {
    const f = fixture({ admission: "strict" });
    let provider: Promise<void> | undefined;
    const result = await admission(f.store).run(async () => {
      provider = f.storage.borrow(async () => undefined).catch(() => undefined);
      await tick();
      // A fresh root would deadlock here until timeout; a nested call joins.
      return admission(f.store).run(() => f.project("nested", 3605).name);
    });
    expect(result).toBe("nested");
    await provider;
  });

  it("keeps an operation admitted until joined calls it started have settled", async () => {
    const f = fixture({ admission: "strict" });
    const finish = gate();
    let joined: Promise<string> | undefined;
    await admission(f.store).run(() => {
      joined = admission(f.store).run(async () => { await finish.opened; return f.project("joined", 3613).name; });
    });
    let borrowed = false;
    const provider = f.storage.borrow(async () => { borrowed = true; });
    await tick();
    expect(borrowed).toBe(false);
    finish.open();
    expect(await joined).toBe("joined");
    await provider;
    expect(borrowed).toBe(true);
  });

  it("releases the whole operation when a nested call idles", async () => {
    const f = fixture({ admission: "strict" });
    const network = gate();
    const order: string[] = [];
    const outer = admission(f.store).run(() => admission(f.store).run(async () => {
      await admission(f.store).idle(() => network.opened);
      order.push("resumed");
      return f.project("nested-idle", 3614).name;
    }));
    await tick();
    await f.storage.borrow(async () => { order.push("provider"); });
    network.open();
    expect(await outer).toBe("nested-idle");
    expect(order).toEqual(["provider", "resumed"]);
  });

  it("bounds core waiting by queue size, admission deadline and cancellation without ever running refused callbacks", async () => {
    const f = fixture({ admission: "strict", maxQueued: 2, admissionTimeoutMs: 40 });
    const hold = gate();
    const borrowed = f.storage.borrow(() => hold.opened);
    const ran: string[] = [];
    const controller = new AbortController();
    const timedOut = admission(f.store).run(() => { ran.push("timeout"); });
    const cancelled = admission(f.store).run(() => { ran.push("cancel"); }, { signal: controller.signal, admissionTimeoutMs: 5_000 });
    expect(await asyncCode(() => admission(f.store).run(() => { ran.push("full"); }))).toBe("queue_full");
    controller.abort();
    expect(await asyncCode(() => cancelled)).toBe("cancelled");
    expect(await asyncCode(() => timedOut)).toBe("admission_timeout");
    const aborted = new AbortController(); aborted.abort();
    expect(await asyncCode(() => admission(f.store).run(() => { ran.push("pre-aborted"); }, { signal: aborted.signal }))).toBe("cancelled");
    hold.open();
    await borrowed;
    expect(ran).toEqual([]);
    expect(snapshot(f.store)).toMatchObject({ coreActive: 0, queuedCore: 0, queuedProviders: 0, providerActive: false });
  });

  it("keeps an admitted operation admitted until its body settles, however long, and never times it out", async () => {
    const f = fixture({ admission: "strict", admissionTimeoutMs: 30 });
    const finish = gate();
    const effect = admission(f.store).run(async () => { await finish.opened; return f.project("late-commit", 3606).name; });
    expect(await asyncCode(() => f.storage.borrow(async () => undefined))).toBe("admission_timeout");
    finish.open();
    expect(await effect).toBe("late-commit");
  });

  it("refuses core-to-provider upgrades and core admission inside a provider operation immediately", async () => {
    const f = fixture({ admission: "strict" });
    expect(await admission(f.store).run(() => asyncCode(() => f.storage.borrow(async () => undefined)))).toBe("reentrant");
    const inside = await f.storage.borrow(async () => ({
      run: await asyncCode(() => admission(f.store).run(() => undefined)),
      detached: await asyncCode(() => admission(f.store).detached(() => undefined)),
      idle: await asyncCode(() => admission(f.store).idle(async () => undefined)),
      direct: code(() => f.store.listProjects()),
      joined: f.storage.runControllerOperation(() => f.store.listProjects().length),
    }));
    expect(inside).toEqual({ run: "reentrant", detached: "reentrant", idle: "reentrant", direct: "busy", joined: 0 });
  });

  it("releases admission during idle work so a provider can run, then re-admits the caller behind it", async () => {
    const f = fixture({ admission: "strict" });
    const order: string[] = [];
    const network = gate();
    const operation = admission(f.store).run(async () => {
      order.push("validate");
      await admission(f.store).idle(async () => {
        expect(code(() => f.store.listProjects())).toBe("unadmitted");
        await network.opened;
      });
      order.push("commit");
      return f.project("after-idle", 3607).name;
    });
    await tick();
    const provider = f.storage.borrow(async () => { order.push("provider"); });
    await provider;
    network.open();
    expect(await operation).toBe("after-idle");
    expect(order).toEqual(["validate", "provider", "commit"]);
  });

  it("closes cursors an admitted operation left open before the next provider transaction", async () => {
    const f = fixture({ admission: "strict" });
    await admission(f.store).run(() => { f.project("one", 3608); f.project("two", 3609); });
    let iterator: IterableIterator<unknown> | undefined;
    await admission(f.store).run(() => {
      iterator = f.core.prepare("SELECT id FROM projects").iterate();
      iterator.next();
    });
    const connection = raw(f);
    await f.storage.borrow(async () => {
      connection.prepare("BEGIN").run([]);
      connection.prepare(insertUser).run(userValues("after-core-cursor"));
      connection.prepare("COMMIT").run([]);
    });
    expect(providerUsers(f.path)).toBe(1);
    expect(code(() => iterator!.next())).toBe("unadmitted");
  });

  it("holds the owner lock through a running backup, refuses a failed close and closes once work drained", async () => {
    const f = fixture({ admission: "strict" });
    await admission(f.store).run(() => f.project("backed-up", 3610));
    // Only initiation is admitted; the gate's backup hold lasts until the driver settles.
    const { backup } = await admission(f.store).run(() => ({ backup: f.store.backup(join(f.root, "drain.sqlite3"), { progress: () => 1 }) }));
    expect(snapshot(f.store)).toMatchObject({ coreActive: 0, backups: 1 });
    stores.splice(stores.indexOf(f.store), 1);
    const closing = f.store.closeAfterDrain(5_000);
    await expect(f.storage.borrow(async () => undefined)).rejects.toMatchObject({ code: "provider_closed" });
    expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    await backup;
    await closing;
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    expect(committed(join(f.root, "drain.sqlite3"), db => (db.prepare("SELECT count(*) n FROM projects").get() as { n: number }).n)).toBe(1);
  });

  it("keeps ownership when drain or the driver close cannot be confirmed, and closes on retry", async () => {
    const f = fixture({ admission: "strict" });
    const finish = gate();
    const held = admission(f.store).run(() => finish.opened);
    await expect(f.store.closeAfterDrain(20)).rejects.toThrow(/ownership is retained/);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    finish.open(); await held;
    const compatible = fixture();
    compatible.project("a", 3611); compatible.project("b", 3612);
    const iterator = compatible.core.prepare("SELECT id FROM projects").iterate();
    iterator.next();
    stores.splice(stores.indexOf(compatible.store), 1);
    expect(() => compatible.store.close()).toThrow(/busy/);
    expect(existsSync(`${compatible.path}.owner.lock`)).toBe(true);
    iterator.return?.();
    compatible.store.close();
    expect(existsSync(`${compatible.path}.owner.lock`)).toBe(false);
    stores.splice(stores.indexOf(f.store), 1);
    await f.store.closeAfterDrain(1_000);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
  });

  it("tracks a timed-out provider execution until it settles and denies its late SQL", async () => {
    const f = fixture({ admission: "strict", borrowTimeoutMs: 30 });
    const connection = raw(f);
    const resume = gate();
    let late: string | undefined;
    const execution = f.storage.borrow(async () => {
      await resume.opened;
      late = code(() => connection.prepare("SELECT 1").all([]));
      return f.storage.operationActive();
    });
    expect(await asyncCode(() => execution)).toBe("expired");
    expect(await f.storage.drain(20)).toBe(false);
    expect(await admission(f.store).run(() => f.store.listProjects().length)).toBe(0);
    resume.open();
    expect(await f.storage.drain(1_000)).toBe(true);
    expect(late).toBe("released");
  });
});
