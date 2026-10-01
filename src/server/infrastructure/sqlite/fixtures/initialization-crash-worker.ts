import { OwnedSqliteDatabase } from "../owned-database";
import { configureDurability } from "../database-validation";
import { initializeSchema } from "../migrations";

const owned = new OwnedSqliteDatabase(process.argv[2], true);
const db = owned.enableWrites();
configureDurability(db);
const exec = db.exec.bind(db);
db.exec = sql => {
  const result = exec(sql);
  if (process.argv[3] === "fresh" ? sql.includes("CREATE TABLE IF NOT EXISTS projects") : sql.includes("ADD COLUMN checksum")) {
    process.send?.({ interrupted: true }, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
    // Hold the transaction before returning to the migrator.
    const deadline = Date.now() + 100;
    while (Date.now() < deadline) { /* let IPC publish before blocking */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
initializeSchema(db, owned.inspection.fresh);
owned.close();
