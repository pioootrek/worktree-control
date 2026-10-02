import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { z } from "zod";
import { readBoundedJson } from "@/server/infrastructure/sqlite";
import { durableJson, syncDirectory } from "@/server/private-storage";
import { dirname } from "node:path";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const recordHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
/** Server-owned durable records, never hydrated from the restored database. */
export function readRecord<T>(path: string, schema: z.ZodType<T>): T | null {
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const record = z.object({ payload: schema, sha256: z.string() }).strict().parse(readBoundedJson(path, 4 * 1024 * 1024, true));
  if (record.sha256 !== recordHash(record.payload)) throw new Error("Corrupt backup operation record; preserve it for inspection.");
  // Repair the publication boundary before accepting/replaying a visible record.
  syncDirectory(dirname(path));
  return record.payload;
}
export function writeRecord(path: string, payload: unknown): void {
  const record = { payload, sha256: recordHash(payload) };
  if (Buffer.byteLength(JSON.stringify(record)) > 4 * 1024 * 1024) throw new Error("Backup operation record exceeds its size limit.");
  durableJson(path, record);
}
