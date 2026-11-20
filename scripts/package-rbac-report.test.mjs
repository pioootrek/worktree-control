import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceError } from "./package-rbac-report.mjs";

test("installed failure report preserves the cause and removes secrets and temporary roots before bounding", () => {
  const secret = "fixture-secret-123", root = "/private/fixture-root";
  const message = acceptanceError(new TypeError(`no such function: worktree_security_pending ${secret} ${root}/db ${"x".repeat(400)}`), new Set([secret]), [root, undefined]);
  assert(message.startsWith("TypeError: no such function: worktree_security_pending"));
  assert(!message.includes(secret)); assert(!message.includes(root)); assert.equal(message.length, 300);
  const crossing = acceptanceError(new Error(`${"x".repeat(285)}${secret}`), new Set([secret]), []);
  assert(!crossing.includes("fixture-secret"));
  assert.equal(acceptanceError("non-error fixture throw", new Set(), []), "string: non-error fixture throw");
  assert(!acceptanceError(new assert.AssertionError({ message: secret }), new Set([secret]), []).includes(secret));
});
