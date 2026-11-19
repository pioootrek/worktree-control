import type Database from "better-sqlite3";

/**
 * The project ID diagnostic of `upgrade inspect`. The breaking release needs
 * every Knowledge project ID to match the authorization contract's grammar
 * (`ID_PATTERN` in `src/shared/contracts/operations.ts`); today Knowledge
 * accepts any trimmed ID of up to 160 characters, so an installation may hold
 * IDs outside it. This only reports them, beside the plan and outside its
 * hash. `apply` neither reads nor refuses on this report and changes no ID;
 * prevention in create and import and a repair procedure are later steps.
 */

/**
 * The contract's grammar. It is declared here, not imported, as the other
 * store code does for the unmounted operations contract (see
 * `project-directory-queries.ts`: `unmounted.test.ts` refuses every import of
 * that contract outside the approved composition). `upgrade-project-ids.test.ts`
 * keeps this equal to the contract's pattern by reading the contract's source.
 */
export const PROJECT_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** The most IDs listed and the most code points of one ID shown; the count is always complete. */
export const PROJECT_ID_REPORT_LIMITS = { entries: 100, idCodePoints: 200 } as const;

export interface NonConformingProjectId {
  /** The stored ID as JSON text, exact up to {@link PROJECT_ID_REPORT_LIMITS}; null when the stored value is not text. */
  id: string | null;
  /** The project's status; null when the stored value is neither `active` nor `archived`. */
  status: "active" | "archived" | null;
  /** Present when the ID is longer than the limit and `id` is its first {@link PROJECT_ID_REPORT_LIMITS} code points. */
  idCut?: true;
}
export interface ProjectIdReport {
  /** The grammar's source text, for the operator. */
  grammar: string;
  /** Every Knowledge project (active and archived) whose ID is outside the grammar. */
  count: number;
  /** The most entries `projects` lists. */
  limit: number;
  /** Whether `projects` lists fewer than `count`. */
  truncated: boolean;
  /** The first `limit` of them in ascending byte order of the stored ID. */
  projects: NonConformingProjectId[];
  /** The operator's line; present only when `count` is above zero. Fixed text and the count: no ID is interpolated. */
  notice?: string;
}

/** The one operator line; it names no ID, so no stored text reaches it. */
export const projectIdNotice = (count: number): string =>
  `${count} Knowledge project ID(s) do not match the contract grammar (listed in projectIds, active and archived alike): these projects will not be reachable through the new authorization until their IDs conform; there is no supported rename yet, and the release is blocked on it.`;

interface Row { head: Buffer | null; bytes: number | null; status: unknown }

/** The most bytes read of one ID: enough for the shown code points plus one, at four bytes each. */
const HEAD_BYTES = (PROJECT_ID_REPORT_LIMITS.idCodePoints + 1) * 4;

/**
 * Reads `knowledge_projects` (read-only, any schema from 49 on) and reports the
 * IDs outside the grammar. A stored value that is not text is outside it. Only
 * the first bytes of an ID are read into memory.
 *
 * The ID is read as bytes, never through SQLite's text functions: `substr()`
 * and `length()` on text stop at the first U+0000, so `valid\0suffix` would
 * look like the conforming `valid`. The grammar is ASCII, so a conforming ID
 * has as many bytes as characters, at most 160, and no NUL.
 */
export function inspectProjectIds(database: Database.Database): ProjectIdReport {
  const rows = database.prepare(`SELECT CASE WHEN typeof(id)='text' THEN substr(CAST(id AS BLOB),1,${HEAD_BYTES}) END AS head,
      CASE WHEN typeof(id)='text' THEN length(CAST(id AS BLOB)) END AS bytes, status FROM knowledge_projects ORDER BY id, rowid`).iterate() as IterableIterator<Row>;
  const projects: NonConformingProjectId[] = [];
  let count = 0;
  for (const row of rows) {
    const whole = row.head !== null && row.bytes !== null && row.head.length === row.bytes;
    const text = row.head === null ? null : row.head.toString("utf8");
    const conforming = whole && text !== null && row.bytes! <= 160 && PROJECT_ID_GRAMMAR.test(text);
    if (conforming) continue;
    count++;
    if (projects.length >= PROJECT_ID_REPORT_LIMITS.entries) continue;
    const status = row.status === "active" || row.status === "archived" ? row.status : null;
    if (text === null) { projects.push({ id: null, status }); continue; }
    // A prefix cut by bytes may end inside a character; that fragment decodes to U+FFFD and is dropped.
    const points = [...(whole ? text : text.replace(/\uFFFD$/u, ""))];
    const cut = !whole || points.length > PROJECT_ID_REPORT_LIMITS.idCodePoints;
    projects.push({ id: cut ? points.slice(0, PROJECT_ID_REPORT_LIMITS.idCodePoints).join("") : text, status, ...(cut ? { idCut: true as const } : {}) });
  }
  return {
    grammar: PROJECT_ID_GRAMMAR.source, count, limit: PROJECT_ID_REPORT_LIMITS.entries, truncated: count > projects.length, projects,
    ...(count > 0 ? { notice: projectIdNotice(count) } : {}),
  };
}
