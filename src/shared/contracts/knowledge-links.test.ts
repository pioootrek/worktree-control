import { expect, it } from "vitest";
import { knowledgeSourceHref } from "./knowledge-links";

it("keeps an exact reply destination only when its parent thread is known", () => {
  const source = { kind: "reply" as const, id: "reply/30", revision: 2 };
  expect(knowledgeSourceHref("project A", source, "thread/1")).toBe("?view=knowledge&knowledgeProject=project%20A&knowledgeTab=discussions&record=thread%2F1&reply=reply%2F30");
  expect(knowledgeSourceHref("project A", source)).toBe("");
  expect(knowledgeSourceHref("project A", {kind:"task",id:"task",revision:1}, "ignored")).toContain("record=task");
});
