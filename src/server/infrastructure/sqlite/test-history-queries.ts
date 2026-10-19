import type Database from "better-sqlite3";
import type { TestRunSummary } from "@/shared/contracts";
import type { TestHistoryCoverage, TestSummaryEntry } from "@/shared/contracts/verification-history";
import { TestSummaryQueries } from "./test-summary-queries";

import type { TestHistoryPosition as HistoryPosition, TestHistoryScan as HistoryScan } from "@/server/state-store";
/** Index range and LIMIT bound visited project rows before any JSON filter is evaluated. */
export function historyScanSql(input: HistoryScan) {
  return `SELECT s.run_id,s.queued_at,s.summary_json,
    EXISTS(SELECT 1 FROM test_runs d WHERE d.id=s.run_id AND d.project_id=s.project_id) detail_available
    FROM test_run_summaries s WHERE s.project_id=? AND s.queued_at>=?
    AND (s.queued_at,s.run_id)${input.before ? "<" : "<="}(?,?)
    ORDER BY s.queued_at DESC,s.run_id DESC LIMIT ?`;
}
export class TestHistoryQueries {
  constructor(private readonly database: Database.Database) {}

  scan(input: HistoryScan, scanLimit: number, accept: (entry: TestSummaryEntry) => boolean, matchLimit: number) {
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > 5000 || !Number.isInteger(matchLimit) || matchLimit < 1 || matchLimit > 5000) throw new Error("Invalid verification query budget.");
    // The signed before key is always at/below the initial ceiling. One upper
    // tuple lets SQLite seek directly even through thousands of equal timestamps.
    const upper = input.before ?? input.ceiling ?? { queuedAt: input.to, runId: "\uffff" };
    const args: (string | number)[] = [input.projectId, input.from, upper.queuedAt, upper.runId];
    args.push(scanLimit + 1);
    const iterator = this.database.prepare(historyScanSql(input)).iterate(...args) as IterableIterator<{
      run_id: string; queued_at: string; summary_json: string; detail_available: number;
    }>;
    const items: TestSummaryEntry[] = [];
    let scanned = 0, more = false;
    let last: HistoryPosition | undefined, ceiling = input.ceiling;
    try {
      for (const row of iterator) {
        if (scanned >= scanLimit || items.length >= matchLimit) { more = true; break; }
        ceiling ??= { queuedAt: row.queued_at, runId: row.run_id };
        scanned++; last = { queuedAt: row.queued_at, runId: row.run_id };
        const entry = { summary: JSON.parse(row.summary_json) as TestRunSummary, detailAvailable: !!row.detail_available };
        if (accept(entry)) items.push(entry);
      }
    } finally { iterator.return?.(); }
    return { items, scanned, more, last, ceiling };
  }

  get(projectId: string, runId: string): TestSummaryEntry | null {
    const row = this.database.prepare(`SELECT s.summary_json,
      EXISTS(SELECT 1 FROM test_runs d WHERE d.id=s.run_id AND d.project_id=s.project_id) detail_available
      FROM test_run_summaries s WHERE s.run_id=? AND s.project_id=?`).get(runId, projectId) as {
        summary_json: string; detail_available: number;
      } | undefined;
    return row ? { summary: JSON.parse(row.summary_json) as TestRunSummary, detailAvailable: !!row.detail_available } : null;
  }

  coverage(projectId: string): TestHistoryCoverage {
    return { ...new TestSummaryQueries(this.database).coverage(projectId), historicalCompleteness: "not_guaranteed" };
  }
}
