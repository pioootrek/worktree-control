import type Database from "better-sqlite3";

/**
 * Stored text that reads back exactly (used only by the upgrade's mapping and
 * authority acts and by the test-run recovery's predictor).
 *
 * SQLite stores the bytes of a text value as it was given them and does not
 * check that they are UTF-8. better-sqlite3 decodes them into a JavaScript
 * string, and an invalid sequence becomes U+FFFD: two stored values that
 * differ can read back equal, and a value read back and bound again is other
 * bytes than the stored ones, so `WHERE id=?` matches no row and a foreign key
 * written from it names no row. Every identifier that a pass compares in
 * JavaScript, or that an act writes back or matches on, is therefore refused
 * unless its stored bytes (`CAST(column AS BLOB)`, read in the same statement)
 * are exactly the UTF-8 encoding of the string read back.
 */

/** True when `bytes`, the stored value's own bytes (`CAST(column AS BLOB)`), are exactly the UTF-8 encoding of `value`, the same column read back as a JavaScript string. */
export function readsBack(value: unknown, bytes: unknown): boolean {
  return typeof value === "string" && Buffer.isBuffer(bytes) && Buffer.from(value, "utf8").equals(bytes);
}

/** A table, the column that names an offending row, and the text columns that must read back exactly. */
export interface TextColumns { readonly table: string; readonly key: string; readonly columns: readonly string[] }
/** One row whose text does not read back: its key when that reads back exactly, otherwise `rowid N`, and the problem, naming the columns and never a value. */
export interface UnreadableText { readonly table: string; readonly id: string; readonly problem: string }

/**
 * Every row of `entry.table` holding, in one of `entry.columns`, a text value
 * that does not read back exactly ({@link readsBack}), in rowid order: the
 * first `limit` rows, and the count of all. Values of another storage class
 * are not checked here; the caller's storage-class check refuses them. The
 * tables named must be rowid tables. Read-only.
 */
export function unreadableTexts(database: Database.Database, entry: TextColumns, limit: number): { rows: UnreadableText[]; count: number } {
  const columns = [entry.key, ...entry.columns.filter(column => column !== entry.key)];
  const select = columns.map(column => `typeof("${column}"),CAST("${column}" AS BLOB),"${column}"`).join(",");
  const where = entry.columns.map(column => `typeof("${column}")='text'`).join(" OR ");
  const rows: UnreadableText[] = [];
  let count = 0;
  for (const row of database.prepare(`SELECT rowid,${select} FROM "${entry.table}" WHERE ${where} ORDER BY rowid`).raw().safeIntegers(true).iterate() as Iterable<unknown[]>) {
    const text = (index: number) => row[1 + index * 3] === "text";
    const exact = (index: number) => readsBack(row[3 + index * 3], row[2 + index * 3]);
    const failed = columns.filter((column, index) => entry.columns.includes(column) && text(index) && !exact(index));
    if (failed.length === 0) continue;
    count++;
    if (rows.length >= limit) continue;
    rows.push({ table: entry.table, id: text(0) && exact(0) ? row[3] as string : `rowid ${String(row[0])}`, problem: failed.map(column => `${column} is not valid UTF-8 text`).join("; ") });
  }
  return { rows, count };
}
