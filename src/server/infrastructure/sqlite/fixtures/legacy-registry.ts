import type Database from "better-sqlite3";

/** Synthetic downgrade fixtures must also restore the pre-provenance registry. */
export function stripMigrationProvenance(database: Database.Database): void {
  const columns = database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  if (columns.some(column => column.name === "checksum")) database.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");
  if (columns.some(column => column.name === "name")) database.exec("ALTER TABLE schema_migrations DROP COLUMN name");
}
