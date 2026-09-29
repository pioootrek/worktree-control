import { describe, expect, it } from "vitest";
import type { KnowledgeHistoryEntry } from "@/shared/contracts/knowledge";
import { memoryHistoryComparison } from "./knowledge-history-projection";

const snapshot = (revision: number, status = "active", body = "First") => ({
  id: "memory-1", projectId: "project-1", revision, title: "Decision", body,
  category: "decision", status, tags: ["one"], legacyId: null, sources: [{ kind: "task", id: "task-1", revision: 1 }],
  approval: null, supersededBy: null,
});
const event = (revision: number, previousJson: string | null, operation: KnowledgeHistoryEntry["operation"] = "updated"): KnowledgeHistoryEntry => ({
  id: revision, projectId: "project-1", recordKind: "memory", recordId: "memory-1", operation,
  previousJson, principalId: "agent-1", authenticationMethod: "agent_token", revision, createdAt: "2026-09-29T10:00:00Z",
});

describe("Memory history comparison", () => {
  it("uses the immediate successor snapshot across a page boundary", () => {
    const first = event(1, null, "created");
    const next = event(2, JSON.stringify(snapshot(1)));
    expect(memoryHistoryComparison(first, next, snapshot(27))).toEqual({ before: null, after: expect.objectContaining({ body: "First" }) });
    expect(memoryHistoryComparison(next, undefined, snapshot(2, "active", "Second"))).toEqual({ before: expect.objectContaining({ body: "First" }), after: expect.objectContaining({ body: "Second" }) });
  });

  it("rejects gaps, changed scope, malformed and oversized snapshots", () => {
    const first = event(1, null, "created");
    expect(memoryHistoryComparison(first, event(3, JSON.stringify(snapshot(2))), null)).toBeNull();
    expect(memoryHistoryComparison(first, { ...event(2, JSON.stringify(snapshot(1))), projectId: "other" }, null)).toBeNull();
    expect(memoryHistoryComparison(first, event(2, "{"), null)).toBeNull();
    expect(memoryHistoryComparison(first, event(2, "x".repeat(262145)), null)).toBeNull();
    expect(memoryHistoryComparison(first, undefined, snapshot(2))).toBeNull();
    expect(memoryHistoryComparison(event(2, JSON.stringify(snapshot(1))), undefined, snapshot(3))).toBeNull();
  });

  it("rejects forged snapshot identity and unbounded values", () => {
    const after = event(2, JSON.stringify({ ...snapshot(1), projectId: "other" }));
    expect(memoryHistoryComparison(event(1, null, "created"), after, null)).toBeNull();
    const huge = event(2, JSON.stringify({ ...snapshot(1), body: "x".repeat(65537) }));
    expect(memoryHistoryComparison(event(1, null, "created"), huge, null)).toBeNull();
  });
});
