// Isolated writer fixture. Its parent kills it before SQLite can checkpoint on close.
import Database from "better-sqlite3";

const database = new Database(process.argv[2]!);
database.pragma("journal_mode = WAL");
database.pragma("wal_autocheckpoint = 0");
database.prepare("UPDATE projects SET name = 'Committed in WAL' WHERE id = 'kept'").run();
if (process.argv[3] === "future") {
  database.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(28,'future')");
}
process.send?.({ committed: true });
setInterval(() => {}, 1000);
