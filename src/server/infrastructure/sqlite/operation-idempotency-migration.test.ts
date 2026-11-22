import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION, schemaTarget } from "./migration-registry";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { schemaTriggersAt } from "./security-coverage";
import { structuralSteps, upgradeTarget } from "./upgrade-plan";
import { rewindOperationIdempotency } from "./fixtures/schema-rewind";
import {
  invalidateOperationIdempotency, OPERATION_IDEMPOTENCY_HORIZON_MS, OPERATION_IDEMPOTENCY_VERSION, operationIdempotencyChecksum, operationIdempotencyMigration,
} from "./operation-idempotency-migration";

/** Step 53: the structure of the idempotency records, its recognition and its invalidation. */
const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const at = (target?: number) => {
  const database = new Database(":memory:");
  databases.push(database);
  initializeSchema(database, true, current => { inspectSchema(current, target); }, { target });
  return database;
};
const refusal = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } return "accepted"; };
const sql = (database: Database.Database, name: string) => (database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string } | undefined)?.sql;
const KEY_ID = "0123456789abcdef0123456789abcdef";
const PRINT = `hmac-sha256:v1:${"e".repeat(64)}`;
type Row = Partial<Record<"operation_id" | "principal" | "idempotency_key" | "attempt" | "key_id" | "fingerprint" | "state" | "resources_json" | "result_json" | "transitions_json" | "charged_bytes" | "created_at" | "updated_at" | "expires_at", unknown>>;
function insert(database: Database.Database, change: Row = {}) {
  const row: Row = { operation_id: "fixture.write", principal: "account:alice", idempotency_key: "k-1", attempt: "attempt-1", key_id: KEY_ID, fingerprint: PRINT, state: "completed",
    resources_json: "{}", result_json: "null", transitions_json: null, charged_bytes: 6, created_at: 1, updated_at: 1, expires_at: 100, ...change };
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO operation_idempotency(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(row));
}

describe("schema step 53: operation idempotency records", () => {
  it("is the supported version: the default target, ceiling and upgrade target, with its name, checksum and structural step", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(53);
    expect(OPERATION_IDEMPOTENCY_VERSION).toBe(53);
    expect(schemaTarget()).toBe(53);
    expect(upgradeTarget()).toBe(53);
    expect(operationIdempotencyMigration.name).toBe("operation-idempotency-structure");
    expect(operationIdempotencyChecksum).toBe(createHash("sha256").update(`53\0operation-idempotency-structure\0${operationIdempotencyMigration.sql}`).digest("hex"));
    expect(structuralSteps(49, 53).map(step => step.version)).toEqual([50, 51, 52, 53]);
    expect(structuralSteps(52, 53)).toEqual([{ version: 53, name: operationIdempotencyMigration.name, checksum: operationIdempotencyChecksum }]);
    // The table adds no trigger: it is not covered by the security fence.
    expect(schemaTriggersAt(53)).toEqual(schemaTriggersAt(52));
    expect(() => schemaTarget(54)).toThrow("Unsupported schema target.");
  });

  it("is created fresh at 53 with its exact text and indexes, and recorded with its checksum", () => {
    const database = at();
    expect(inspectSchema(database)).toEqual({ version: 53, fresh: false });
    expect(`${sql(database, "operation_idempotency")};\n${sql(database, "operation_idempotency_principal")};\n${sql(database, "operation_idempotency_expiry")};`)
      .toBe(operationIdempotencyMigration.sql);
    expect(database.prepare("SELECT name,checksum FROM schema_migrations WHERE version=53").get()).toEqual({ name: operationIdempotencyMigration.name, checksum: operationIdempotencyChecksum });
  });

  it("is neither applied nor recognised below 53, and a 53 database is refused there as an unknown newer schema", () => {
    for (const target of [49, 50, 51, 52]) {
      const database = at(target);
      expect(sql(database, "operation_idempotency"), String(target)).toBeUndefined();
      expect(inspectSchema(database)).toEqual({ version: target, fresh: false });
    }
    expect(refusal(() => inspectSchema(at(), 52))).toMatch(/Unsupported or unrecognized database schema/);
  });

  it("refuses an early, missing, reshaped, re-indexed or mis-recorded table", () => {
    const early = at(52);
    early.exec(operationIdempotencyMigration.sql);
    expect(refusal(() => inspectSchema(early))).toMatch(/operation_idempotency precedes its migration/);
    const missing = at();
    missing.exec("DROP TABLE operation_idempotency");
    expect(refusal(() => inspectSchema(missing))).toMatch(/Unsupported or unrecognized/);
    const reshaped = at();
    reshaped.exec(`DROP TABLE operation_idempotency; ${operationIdempotencyMigration.sql.replace("BETWEEN 0 AND 262144", "BETWEEN 0 AND 262145")}`);
    expect(refusal(() => inspectSchema(reshaped))).toMatch(/shape of operation_idempotency/);
    const unindexed = at();
    unindexed.exec("DROP INDEX operation_idempotency_expiry");
    expect(refusal(() => inspectSchema(unindexed))).toMatch(/indexes of operation_idempotency/);
    const extra = at();
    extra.exec("CREATE INDEX operation_idempotency_extra ON operation_idempotency(state)");
    expect(refusal(() => inspectSchema(extra))).toMatch(/indexes of operation_idempotency/);
    const checksum = at();
    checksum.prepare("UPDATE schema_migrations SET checksum=? WHERE version=53").run("0".repeat(64));
    expect(refusal(() => inspectSchema(checksum))).toMatch(/migration checksum or name/);
  });

  it("rolls back with the whole schema transaction when an act fails", () => {
    const database = at(52);
    expect(() => initializeSchema(database, false, undefined, { acts: () => { throw new Error("act failed"); } })).toThrow("act failed");
    expect(inspectSchema(database)).toEqual({ version: 52, fresh: false });
    expect(sql(database, "operation_idempotency")).toBeUndefined();
    initializeSchema(database, false, current => { inspectSchema(current); });
    expect(inspectSchema(database)).toEqual({ version: 53, fresh: false });
  });

  it("is rewound by the synthetic fixture to a database recognised at 52", () => {
    const database = at();
    rewindOperationIdempotency(database);
    expect(inspectSchema(database, 52)).toEqual({ version: 52, fresh: false });
  });

  it("ties state to payload and expiry, and keeps SQL NULL apart from a retained JSON null", () => {
    const database = at();
    insert(database);
    expect(database.prepare("SELECT result_json FROM operation_idempotency").pluck().get()).toBe("null");
    insert(database, { idempotency_key: "k-2", state: "reserved", result_json: null, expires_at: null, charged_bytes: 262144 });
    insert(database, { idempotency_key: "k-3", state: "unknown", result_json: null, transitions_json: null });
    insert(database, { idempotency_key: "k-4", transitions_json: '{"slot":null}' });
    const refused: Row[] = [
      { state: "reserved" }, { state: "completed", result_json: null }, { state: "unknown" }, { state: "unknown", result_json: null, transitions_json: "{}" },
      { state: "started", result_json: null }, { state: "unknown", result_json: null, expires_at: null }, { state: "other" },
      { fingerprint: `hmac-sha256:v1:${"E".repeat(64)}` }, { fingerprint: `hmac-sha256:v2:${"e".repeat(64)}` }, { fingerprint: PRINT.slice(0, -1) },
      { key_id: KEY_ID.toUpperCase() }, { key_id: KEY_ID.slice(1) }, { idempotency_key: "has space" }, { idempotency_key: "x".repeat(129) }, { idempotency_key: "" },
      { idempotency_key: "nul\u0000byte" }, { operation_id: "Fixture.Write" }, { principal: "account:al ice" }, { attempt: "" },
      { resources_json: "not json" }, { result_json: "{" }, { transitions_json: "[" }, { charged_bytes: 262145 }, { charged_bytes: -1 }, { charged_bytes: 1.5 },
      { updated_at: -1 }, { expires_at: 1.5 }, { operation_id: null }, { resources_json: null },
    ];
    for (const [index, change] of refused.entries()) {
      expect(() => insert(database, { idempotency_key: `bad-${index}`, ...change }), JSON.stringify(change)).toThrow(/CHECK constraint failed|NOT NULL constraint failed/);
    }
    expect(() => insert(database)).toThrow(/UNIQUE constraint failed/);
  });

  it("invalidates surviving records: expired ones are deleted, every other becomes unknown once, never extending an expiry", () => {
    const database = at();
    insert(database, { idempotency_key: "completed", expires_at: 1_000 });
    insert(database, { idempotency_key: "expired", expires_at: 500 });
    insert(database, { idempotency_key: "reserved", state: "reserved", result_json: null, expires_at: null, charged_bytes: 262144 });
    insert(database, { idempotency_key: "started", state: "started", result_json: null, expires_at: null, charged_bytes: 262144 });
    insert(database, { idempotency_key: "unknown", state: "unknown", result_json: null, expires_at: 900 });
    insert(database, { idempotency_key: "transitions", transitions_json: '{"slot":null}', expires_at: 2_000 });
    invalidateOperationIdempotency(database, 500);
    const rows = () => database.prepare("SELECT idempotency_key AS k,state,result_json AS r,transitions_json AS t,expires_at AS e,charged_bytes AS c FROM operation_idempotency ORDER BY k").all();
    const horizon = 500 + OPERATION_IDEMPOTENCY_HORIZON_MS;
    expect(rows()).toEqual([
      { k: "completed", state: "unknown", r: null, t: null, e: horizon, c: 2 },
      { k: "reserved", state: "unknown", r: null, t: null, e: horizon, c: 2 },
      { k: "started", state: "unknown", r: null, t: null, e: horizon, c: 2 },
      { k: "transitions", state: "unknown", r: null, t: null, e: horizon, c: 2 },
      { k: "unknown", state: "unknown", r: null, t: null, e: 900, c: 6 },
    ]);
    invalidateOperationIdempotency(database, 600);
    expect(rows()).toEqual(rows());
    expect((rows() as Array<{ e: number }>).map(row => row.e)).toEqual([horizon, horizon, horizon, horizon, 900]);
  });
});
