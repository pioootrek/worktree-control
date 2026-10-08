import { describe, expect, it } from "vitest";
import type { McpSessionDiagnostics } from "@/shared/contracts/mcp-diagnostics";
import { qualifyingIdleMs, remainingLifetimeMs, sortSessions } from "./session-summary";
const now = Date.parse("2026-10-08T12:00:00Z");
const session = (label: number, claims: number, activity: string | null) => ({ label, claims, lastQualifyingActivityAt: activity, createdAt: "2026-10-08T11:00:00Z", closeDueAt: "2026-10-08T12:01:00Z" }) as McpSessionDiagnostics;
describe("MCP session display observations", () => {
  it("keeps never-active sessions unknown and clamps future activity", () => {
    expect(qualifyingIdleMs(session(1, 0, null), now)).toBeNull();
    expect(qualifyingIdleMs(session(1, 0, "2026-10-08T12:01:00Z"), now)).toBe(0);
    expect(qualifyingIdleMs(session(1, 0, "2026-10-08T11:45:00Z"), now + 1000)).toBe(901_000);
  });
  it("orders claim holders first and sorts idle age in both directions without changing the snapshot", () => {
    const rows = [session(1, 0, "2026-10-08T11:00:00Z"), session(2, 2, "2026-10-08T11:45:00Z"), session(3, 0, null)];
    expect(sortSessions(rows, { field: "claims", descending: true }, now).map(row => row.label)).toEqual([2, 1, 3]);
    expect(sortSessions(rows, { field: "idle", descending: true }, now).map(row => row.label)).toEqual([1, 2, 3]);
    expect(sortSessions(rows, { field: "idle", descending: false }, now).map(row => row.label)).toEqual([2, 1, 3]);
    expect(rows.map(row => row.label)).toEqual([1, 2, 3]);
  });
  it("calculates absolute lifetime independently of the earlier policy close deadline", () => {
    const row = session(1, 0, null);
    expect(remainingLifetimeMs(row, 8 * 3600, now)).toBe(7 * 3600_000);
    expect(remainingLifetimeMs(row, 8 * 3600, now + 8 * 3600_000)).toBe(0);
  });
});
