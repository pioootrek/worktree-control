import type Database from "better-sqlite3";

/**
 * One stored value as its storage class and complete content: text and blobs
 * as the hex of every byte (`CAST(x AS BLOB)` keeps them all, NUL included,
 * where `quote()` stops text at the first NUL), integers in exact decimal (read
 * as BigInt), reals as the hex of their IEEE 754 double, NULL as `null`.
 */
export function cell(type: unknown, bytes: unknown, value: unknown): string {
  if (type === "null") return "null";
  if (type === "integer") return `integer:${String(value)}`;
  if (type === "real") { const buffer = Buffer.alloc(8); buffer.writeDoubleBE(value as number); return `real:${buffer.toString("hex")}`; }
  return `${String(type)}:${(bytes as Buffer).toString("hex")}`;
}
/** Every value of every row, exactly ({@link cell}), keyed by table and rowid. */
export function exact(database: Database.Database): Record<string, Record<string, Record<string, string>>> {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
  return Object.fromEntries(tables.map(table => {
    const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
    const rows = database.prepare(`SELECT rowid AS r,${columns.map(column => `typeof("${column}"),CAST("${column}" AS BLOB),"${column}"`).join(",")} FROM "${table}" ORDER BY rowid`)
      .raw().safeIntegers(true).all() as unknown[][];
    return [table, Object.fromEntries(rows.map(row => [String(row[0]), Object.fromEntries(columns.map((column, index) => [column, cell(row[1 + index * 3], row[2 + index * 3], row[3 + index * 3])]))]))];
  }));
}
/** The text or integer a {@link cell} holds (for reading values back). */
export const plain = (value: string) => value.startsWith("integer:") ? Number(value.slice(8)) : value === "null" ? null : Buffer.from(value.slice(value.indexOf(":") + 1), "hex").toString("utf8");
