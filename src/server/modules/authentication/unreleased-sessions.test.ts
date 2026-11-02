import { describe, expect, it } from "vitest";
import { UnreleasedSessions } from "./unreleased-sessions";

describe("UnreleasedSessions", () => {
  it("reports its bound and frees a slot only on removal", () => {
    const sessions = new UnreleasedSessions(2), first = sessions.add("first");
    expect(sessions.full).toBe(false);
    const second = sessions.add("second");
    expect(sessions.full).toBe(true);
    first.phase = "retained";
    expect(sessions.full).toBe(true);
    sessions.remove(first);
    expect(sessions.full).toBe(false);
    expect(sessions.has(first)).toBe(false);
    expect(sessions.all()).toEqual([second]);
  });

  it("holds an identity and lifecycle state, never a cookie, body or actor", () => {
    expect(Object.keys(new UnreleasedSessions(1).add("id")).sort()).toEqual(["cleaning", "phase", "sessionId"]);
  });
});
