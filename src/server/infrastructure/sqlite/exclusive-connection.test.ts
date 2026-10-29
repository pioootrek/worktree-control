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
    expect(reopened.schemaVersion()).toBe(38);
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
