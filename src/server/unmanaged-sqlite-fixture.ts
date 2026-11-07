import Database from "better-sqlite3";

/** Test construction of old/corrupt/offline SQLite files, outside an application
 * owner. Covered rows still change their checkpoint; this no-op cannot publish
 * or confirm a witness. Production always uses the real owned observer. */
export function unmanagedFixtureDatabase(filename:string|Buffer=":memory:",options?:Database.Options):Database.Database {
  const database=new Database(filename,options);
  database.function("worktree_security_pending",()=>0);
  return database;
}

/** Test data manipulation on a live store uses its actual guarded sole handle.
 * This borrowed view owns no connection: the fixture closes its owning store. */
export function ownedFixtureDatabase(store:unknown):Database.Database {
  const core=(store as {database:Database.Database}).database;
  return Object.assign(Object.create(core),{close(){return this;}}) as Database.Database;
}
