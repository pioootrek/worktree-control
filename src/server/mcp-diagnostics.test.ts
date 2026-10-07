import { afterEach, expect, it, vi } from "vitest";
import { McpDiagnostics } from "./mcp-diagnostics";
import { mcpDiagnosticsAdminHandler } from "./mcp-diagnostics-admin";
afterEach(() => vi.useRealTimers());
it("bounds details/history independently of exact aggregate counts and prunes history", () => {
  vi.useFakeTimers();
  const diagnostics = new McpDiagnostics();
  const sessions = Array.from({ length: 100 }, () => diagnostics.create());
  for (const entry of sessions) diagnostics.initialize(entry);
  expect(diagnostics.snapshot()).toMatchObject({ logicalSessions: 100, initializingSessions: 0, omittedSessions: 68 });
  expect(diagnostics.snapshot().sessions).toHaveLength(32);
  for (const entry of sessions) diagnostics.close(entry, "client-delete");
  expect(diagnostics.snapshot()).toMatchObject({ logicalSessions: 0, drainingSessions: 0, closeReasons: { "client-delete": 100 } });
  expect(diagnostics.snapshot().recentClosures).toHaveLength(64);
  vi.advanceTimersByTime(15 * 60_000 + 1);
  expect(diagnostics.snapshot().recentClosures).toEqual([]);
});
it("keeps unknown agent liveness, separates messages from renewal, and counts work until it settles", () => {
  const d = new McpDiagnostics(), s = d.create();
  d.initialize(s); d.change(s, "operations", 1); d.clientMessage(s, true);
  const last = s.lastClientRequestAt;
  d.renewed(s, true);
  expect(s.lastClientRequestAt).toBe(last);
  expect(d.snapshot().sessions[0]).toMatchObject({ agentState: "unknown", transportState: "no-open-response", operations: 1 });
  d.close(s, "controller-shutdown"); d.close(s, "client-delete");
  expect(d.snapshot()).toMatchObject({ logicalSessions: 0, drainingSessions: 1, operations: 1, closeReasons: { "controller-shutdown": 1, "client-delete": 0 } });
  d.change(s, "operations", -1);
  expect(d.snapshot()).toMatchObject({ drainingSessions: 0, operations: 0, sessions: [] });
});
it("caches process samples for five seconds without a sampling timer", () => {
  vi.useFakeTimers();
  const d = new McpDiagnostics(), first = d.snapshot().controllerProcess;
  vi.advanceTimersByTime(4999);
  expect(d.snapshot().controllerProcess).toBe(first);
  vi.advanceTimersByTime(1);
  expect(d.snapshot().controllerProcess).not.toBe(first);
  expect(vi.getTimerCount()).toBe(0);
});
it("validates the exact local admin read and rejects extra fields without reading", async () => {
  const read = vi.fn(async () => ({ mcp: null })), handler = mcpDiagnosticsAdminHandler(read);
  for (const body of [null, [], {}, { command: "other" }, { command: "mcp-diagnostics", token: "secret" }]) expect(() => handler(body)).toThrow("Invalid MCP diagnostics request.");
  expect(read).not.toHaveBeenCalled();
  expect(await handler({ command: "mcp-diagnostics" })).toEqual({ mcp: null });
});
it("orders bounded details by claims, open responses and recent activity, and reports truncation", () => {
  const d = new McpDiagnostics();
  const entries = Array.from({ length: 40 }, () => d.create());
  entries.forEach((entry, index) => { d.initialize(entry); d.qualifyingActivity(entry, new Date(Date.UTC(2026, 9, 7, 12, index)).toISOString()); });
  d.change(entries[3]!, "claims", 1);
  d.change(entries[5]!, "renewalTimers", 1);
  d.change(entries[1]!, "openResponses", 1);
  d.change(entries[0]!, "operations", 1);
  d.renewalSkipped(entries[3]!);
  d.refused();
  const snapshot = d.snapshot();
  // Claim holders and renewal timers (most recent first), then open responses or running operations, then recent activity.
  expect(snapshot.sessions.map(entry => entry.label)).toEqual([6, 4, 2, 1, ...Array.from({ length: 28 }, (_, index) => 40 - index)]);
  expect(snapshot).toMatchObject({ truncated: 8, omittedSessions: 8, renewalsSkippedByPolicy: 1, closeReasons: { "admission-refused": 1 }, logicalSessions: 40 });
  expect(snapshot.sessions[1]).toMatchObject({ renewalsSkippedByPolicy: 1, lastQualifyingActivityAt: "2026-10-07T12:03:00.000Z" });
});
