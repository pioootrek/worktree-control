import { describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { OperationRegistry, type EffectScope, type MutationOperation, type Receipt } from "./operation";
import { createWorld, FIXTURE_FINGERPRINT_KEY, MemoryIdempotency, P } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, receiptValue } from "./runner";
import { fakeStart, input, key, setup } from "./runner-fixture";

/**
 * Secret-safe retention (`29cf8fa5` delta 7, review `ce8aa214` F10): keyed
 * fingerprints, receipts of ids and revisions for secret-bearing
 * operations, and token-style delivery once.
 */
const projectA = P("project-a");
const PASSWORD = "correct horse battery staple";
const TOKEN = "wct_live_6f1d9c8e2b7a4c3d";

interface IssueInput { accountId: string; password: string }
interface Issued { accountId: string; tokenId: string; revision: number; token: string; projectId: ProjectId }
type IssueOperation = MutationOperation<IssueInput, Issued, { accountId: string; tokenId: string; revision: number; token?: string }>;

/** `account.token_issue`-like: the input carries a secret and the result delivers one. */
function issue(counter = { issued: 0 }, receipt?: (result: Issued) => unknown): IssueOperation {
  return {
    id: "fixture.token_issue", kind: "mutation",
    requirement: { require: onProject("roles:manage", "project") },
    parse: raw => ({ accountId: String((raw as IssueInput).accountId), password: String((raw as IssueInput).password) }),
    resources: () => ({ project: { kind: "project", id: projectA } }),
    effect: { mode: "admitted", run: (value: IssueInput, scope: EffectScope) => {
      counter.issued++;
      return { accountId: value.accountId, tokenId: `token-${counter.issued}`, revision: counter.issued, token: TOKEN, projectId: scope.resources.project.projectId };
    } },
    retain: true,
    secret: {
      receipt: receipt ?? (result => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision })),
      projectReceipt: (value: Receipt) => ({ accountId: String(value.accountId), tokenId: String(value.tokenId), revision: Number(value.revision) }),
    } as IssueOperation["secret"],
    publicKeys: ["accountId", "tokenId", "revision", "token"],
    project: result => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision, token: result.token }),
  };
}

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA);
  const alice = fixture.human("alice");
  fixture.grants.grant({ accountId: alice.id, role: "maintainer", scope: { kind: "project", projectId: projectA } });
  const idempotency = new MemoryIdempotency();
  return { world: fixture, alice, idempotency, runner: new OperationRunner(fixture.runtime({ idempotency })) };
}

describe("keyed fingerprints", () => {
  it("stores a keyed digest, never the canonical input text", async () => {
    const { world: fixture, alice, runner, idempotency } = setup();
    const { operation } = fakeStart(fixture);
    expect(await runner.run(operation, alice.context, { ...input, note: "plain-input-marker" }, key("k-1"))).toMatchObject({ ok: true });
    const [record] = [...idempotency.entries.values()];
    expect(record.fingerprint).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/);
    expect(JSON.stringify([...idempotency.entries.values()])).not.toContain("plain-input-marker");
  });

  it("the digest depends on the key: another key never matches the same input", async () => {
    const { world: fixture, alice, idempotency } = setup();
    const { operation, log } = fakeStart(fixture);
    const first = new OperationRunner(fixture.runtime({ idempotency }));
    const second = new OperationRunner(fixture.runtime({ idempotency, fingerprintKey: new Uint8Array(32).fill(9) }));
    expect(await first.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(await first.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
    expect(await second.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict" } });
    expect(log.attempts).toBe(1);
  });

  it("without a key an idempotency key is unavailable; the operation still runs without one", async () => {
    const { world: fixture, alice, idempotency } = setup();
    const { operation, log } = fakeStart(fixture);
    const runtime = { ...fixture.runtime({ idempotency }), fingerprintKey: undefined };
    const runner = new OperationRunner(runtime);
    expect(await runner.run(operation, alice.context, input, key("k-1")))
      .toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "idempotency_unavailable", retry: "none", effect: "not_started" } });
    expect(log.attempts).toBe(0);
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: true });
  });

  it("refuses a short key and copies the key at construction", async () => {
    const { world: fixture, alice, idempotency } = setup();
    expect(() => new OperationRunner(fixture.runtime({ fingerprintKey: new Uint8Array(31) }))).toThrow(TypeError);
    const material = new Uint8Array(FIXTURE_FINGERPRINT_KEY);
    const runner = new OperationRunner(fixture.runtime({ idempotency, fingerprintKey: material }));
    const { operation } = fakeStart(fixture);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    material.fill(1);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
  });
});

describe("secret-bearing operations", () => {
  it("delivers the secret once and retains only a receipt; a replay returns the receipt without it", async () => {
    const { alice, runner, idempotency } = world();
    const counter = { issued: 0 };
    const request = { accountId: "robot", password: PASSWORD };
    expect(await runner.run(issue(counter), alice.context, request, key("k-1")))
      .toEqual({ ok: true, value: { accountId: "robot", tokenId: "token-1", revision: 1, token: TOKEN }, replayed: false });
    const stored = JSON.stringify([...idempotency.entries.values()]);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(PASSWORD);
    expect([...idempotency.entries.values()][0].result).toEqual({ accountId: "robot", tokenId: "token-1", revision: 1 });
    expect(await runner.run(issue(counter), alice.context, request, key("k-1")))
      .toEqual({ ok: true, value: { accountId: "robot", tokenId: "token-1", revision: 1 }, replayed: true });
    expect(counter.issued).toBe(1);
  });

  it("a replay is reauthorized: a caller who lost access gets not_found and no receipt", async () => {
    const { world: fixture, alice, runner } = world();
    const request = { accountId: "robot", password: PASSWORD };
    expect(await runner.run(issue(), alice.context, request, key("k-1"))).toMatchObject({ ok: true });
    fixture.grants.revokeAll(alice.id);
    expect(await runner.run(issue(), alice.context, request, key("k-1")))
      .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
  });

  it("a receipt that is not a flat record of identifiers retains nothing and is never replayed", async () => {
    // The shape check stops a whole result or nested data from being retained by accident. It cannot tell a
    // secret that looks like an identifier from an ID: choosing the receipt's fields is the operation's duty.
    for (const receipt of [(result: Issued) => ({ issued: result }), (result: Issued) => ({ nested: { token: result.token } }),
      (result: Issued) => ({ token: `${result.token} with space` })]) {
      const { alice, runner, idempotency } = world();
      const request = { accountId: "robot", password: PASSWORD };
      expect(await runner.run(issue(undefined, receipt), alice.context, request, key("k-1"))).toMatchObject({
        ok: false, error: { category: "unavailable", reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed" } });
      expect(idempotency.states()).toEqual(["unknown"]);
      expect(JSON.stringify([...idempotency.entries.values()])).not.toContain(TOKEN);
      expect(await runner.run(issue(undefined, receipt), alice.context, request, key("k-1")))
        .toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown" } });
    }
  });

  it("must declare retention and both hooks", () => {
    const operation = issue();
    expect(new OperationRegistry().register(operation).secret).toBeDefined();
    expect(() => new OperationRegistry().register({ ...operation, retain: undefined })).toThrow(TypeError);
    expect(() => new OperationRegistry().register({ ...operation, secret: { receipt: () => ({}) } } as unknown as IssueOperation)).toThrow(TypeError);
  });

  it("receiptValue accepts ids, names, revisions and timestamps only", () => {
    expect(receiptValue({ id: "token-1", revision: 3, names: ["DATABASE_URL", "API_KEY"], expires: "2026-11-13T12:00:00.000Z", active: true, none: null }))
      .toEqual({ id: "token-1", revision: 3, names: ["DATABASE_URL", "API_KEY"], expires: "2026-11-13T12:00:00.000Z", active: true, none: null });
    for (const bad of [{ nested: {} }, { text: "two words" }, { text: "a/b" }, { text: "x=y" }, { n: 1.5 }, { list: [{}] }, [], "id",
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index]))]) {
      let caught: unknown = null;
      try { receiptValue(bad); } catch (error) { caught = error; }
      expect(caught, JSON.stringify(bad)).toMatchObject({ category: "internal", reason: "invalid_receipt" });
    }
  });
});
