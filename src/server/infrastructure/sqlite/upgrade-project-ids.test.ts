import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProjectIds, PROJECT_ID_GRAMMAR, PROJECT_ID_REPORT_LIMITS, projectIdNotice } from "./upgrade-project-ids";

const open: Database.Database[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });
/** The released table's shape for the columns the diagnostic reads; the column types are not enforced, as in the product's tables. */
function table(rows: ReadonlyArray<readonly [id: unknown, status: unknown]>): Database.Database {
  const database = new Database(":memory:");
  open.push(database);
  database.exec("CREATE TABLE knowledge_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,?,1,'t','t')");
  for (const [id, status] of rows) insert.run(id, "Project", status);
  return database;
}

describe("the project ID grammar the diagnostic uses", () => {
  it("is the authorization contract's pattern, read from its source (the contract itself may not be imported here)", () => {
    const source = readFileSync(new URL("../../../shared/contracts/operations.ts", import.meta.url), "utf8");
    const declared = /const ID_PATTERN = \/(.+)\/;/.exec(source);
    expect(declared).not.toBeNull();
    expect(PROJECT_ID_GRAMMAR.source).toBe(declared![1]);
    expect(PROJECT_ID_GRAMMAR.flags).toBe("");
  });
});

describe("inspectProjectIds", () => {
  it("reports nothing, and no notice, when every ID conforms (including the 160-character limit)", () => {
    const report = inspectProjectIds(table([["plain", "active"], ["9starts-with-digit", "archived"], ["a.b:c-d", "active"], ["with_underscore", "active"], ["a".repeat(160), "active"]]));
    expect(report).toEqual({ grammar: PROJECT_ID_GRAMMAR.source, count: 0, limit: 100, truncated: false, projects: [] });
    expect("notice" in report).toBe(false);
    expect(inspectProjectIds(table([]))).toMatchObject({ count: 0, projects: [] });
  });

  it("lists active and archived IDs outside the grammar with their status, in ascending byte order, and nothing else", () => {
    const outside: Array<[string, "active" | "archived"]> = [
      ["has space", "active"], ["with/slash", "archived"], [".leading-dot", "active"], ["-leading-hyphen", "archived"],
      [`${"x".repeat(159)}!`, "active"], ["line\nbreak", "archived"], ["\u001b[31mred", "active"], ['quo"te', "archived"], ["trailing-newline\n", "active"],
      ["semi;colon", "archived"], ["a".repeat(161), "active"], ["zażółć", "archived"], ["", "active"],
    ];
    const report = inspectProjectIds(table([...outside, ["plain", "active"], ["also.ok", "archived"], ["a".repeat(160), "active"]]));
    const expected = [...outside].sort(([a], [b]) => (Buffer.compare(Buffer.from(a), Buffer.from(b)))).map(([id, status]) => ({ id, status }));
    expect(report.count).toBe(outside.length);
    expect(report.truncated).toBe(false);
    expect(report.projects).toEqual(expected);
    expect(report.notice).toBe(projectIdNotice(outside.length));
    // Text that looks like an instruction is data in a JSON string; it never reaches the notice.
    expect(report.notice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]|red|quo|slash/);
  });

  it("bounds the list: the first 100 in order, the complete count, the truncated flag", () => {
    const ids = Array.from({ length: 150 }, (_, index) => `bad id ${String(index).padStart(3, "0")}`);
    const report = inspectProjectIds(table([...ids.map(id => [id, "active"] as const).reverse(), ["good", "active"]]));
    expect(PROJECT_ID_REPORT_LIMITS.entries).toBe(100);
    expect(report).toMatchObject({ count: 150, limit: 100, truncated: true });
    expect(report.projects.map(entry => entry.id)).toEqual(ids.slice(0, 100));
    expect(inspectProjectIds(table(ids.slice(0, 100).map(id => [id, "archived"] as const)))).toMatchObject({ count: 100, truncated: false });
  });

  it("cuts a very long ID at 200 code points and says so; shorter ones are exact", () => {
    const long = `${"é".repeat(150)}${"/".repeat(150)}`;
    const report = inspectProjectIds(table([[long, "active"], ["x".repeat(200) + "/", "active"], ["y".repeat(199) + "/", "active"]]));
    expect(report.count).toBe(3);
    expect(report.projects).toContainEqual({ id: long.slice(0, 200), status: "active", idCut: true });
    expect(report.projects).toContainEqual({ id: "x".repeat(200), status: "active", idCut: true });
    expect(report.projects).toContainEqual({ id: "y".repeat(199) + "/", status: "active" });
  });

  it("reports a stored value that is not text as outside the grammar without a string, and an unknown status as null", () => {
    // The column's TEXT affinity turns a number into text, so only a BLOB and a NULL (which a rowid table's text key allows) are not text.
    const database = table([["fine", "active"]]);
    const insert = database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,?,1,'t','t')");
    insert.run(Buffer.from("abc"), "Blob", "archived");
    insert.run(null, "Null", "odd");
    const report = inspectProjectIds(database);
    expect(report.count).toBe(2);
    expect(report.projects).toEqual(expect.arrayContaining([{ id: null, status: "archived" }, { id: null, status: null }]));
  });

  it("changes nothing in the database", () => {
    const database = table([["bad id", "active"], ["good", "archived"]]);
    const before = database.prepare("SELECT * FROM knowledge_projects ORDER BY rowid").all();
    inspectProjectIds(database);
    expect(database.prepare("SELECT * FROM knowledge_projects ORDER BY rowid").all()).toEqual(before);
  });
});
