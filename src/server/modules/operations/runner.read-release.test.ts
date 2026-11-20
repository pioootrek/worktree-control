import { describe, expect, it, vi } from "vitest";
import { FRESH_LOGIN_WINDOW_MS } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { OperationError } from "./errors";
import type { PhaseScope, QueryOperation, ReadOperation } from "./operation";
import { admissionRefusal, P } from "./operations-fixture";
import { canonicalJson, MAX_RELEASE_DEPTH, MAX_RELEASE_NODES } from "./release";
import { authenticated, onProject } from "./requirements";
import { OperationRunner, type ReadReleaseOptions, type RunOptions } from "./runner";
import { fakeStart, fakeStream, gatedAdmission, projectA, REGISTRATION, setup } from "./runner-fixture";
import { sessionDescribe } from "./session-describe";

type Value = { value: number; nested: { a: number; b: number } };
type Read = ReadOperation<object, Value, Value>;
const options = <P>(commit: (value: P) => void, extra: Partial<ReadReleaseOptions<P>> = {}): ReadReleaseOptions<P> => ({
  eligible: () => true, connected: () => true, deadline: Number.MAX_SAFE_INTEGER, commit, ...extra,
});
const publicError = (category: string, status: number, reason: string, retry = "none") => ({ category, status, reason, retry, effect: null });
function fixture() {
  const state = setup();
  const operation: Read = {
    id: "fixture.read_release", kind: "read", requirement: { require: authenticated() },
    parse: () => ({}), resources: () => ({}), read: () => ({ value: 1, nested: { a: 2, b: 3 } }),
    project: value => value, publicKeys: ["value", "nested"],
  };
  return { ...state, operation };
}

describe("read-release inside admission", () => {
  it("commits exactly the normal path's released value, synchronously inside admission", async () => {
    const { world, runner, alice, operation } = fixture();
    const earlier = await runner.run(operation, alice.context, {});
    if (!earlier.ok) throw new Error("fixture read failed");
    const original = world.admission.run.bind(world.admission);
    world.admission.run = (callback, opts) => original(() => {
      const result = callback();
      expect(result).not.toBeInstanceOf(Promise);
      return result;
    }, opts);
    const commit = vi.fn(value => {
      expect(world.admission.admitted).toBe(true);
      expect(value).toEqual(earlier.value);
      expect(value).not.toBe(earlier.value);
    });
    expect(await runner.readRelease(operation, alice.context, {}, options(commit))).toEqual({ status: "committed" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("calls captured methods with the options object as receiver (reassigned: %s)", async reassign => {
    const { world, alice, operation } = fixture();
    class Release implements ReadReleaseOptions<Value> {
      deadline = Number.MAX_SAFE_INTEGER;
      calls = { eligible: 0, connected: 0, commit: 0 };
      values: Value[] = [];
      eligible() { this.calls.eligible++; return true; }
      connected() { this.calls.connected++; return true; }
      commit(value: Value) { this.calls.commit++; this.values.push(value); }
    }
    const release = new Release();
    const gated = gatedAdmission(world);
    const releasing = new OperationRunner({ ...world.runtime(), admission: gated.admission });
    const pending = releasing.readRelease(operation, alice.context, {}, release);
    expect(release.calls).toEqual({ eligible: 0, connected: 0, commit: 0 });
    const replacements = { eligible: vi.fn(() => false), connected: vi.fn(() => false), commit: vi.fn() };
    if (reassign) Object.assign(release, replacements);
    gated.open();
    expect(await pending).toEqual({ status: "committed" });
    expect(release.calls).toEqual({ eligible: 1, connected: 1, commit: 1 });
    expect(release.values).toEqual([{ value: 1, nested: { a: 2, b: 3 } }]);
    for (const replacement of Object.values(replacements)) expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["read", "project"] as const)("refuses when the deadline is reached during %s", async step => {
    for (const validated of [false, true]) {
      const { world, runner, alice, operation } = fixture();
      const deadline = world.clock.now + 10;
      if (step === "read") {
        const read = operation.read;
        operation.read = (input, phase) => { const value = read(input, phase); world.clock.now = deadline; return value; };
      } else {
        const project = operation.project;
        operation.project = (value, release) => { const projected = project(value, release); world.clock.now = deadline; return projected; };
      }
      const commit = vi.fn();
      expect(await runner.readRelease(operation, alice.context, {}, options(commit, {
        deadline, ...(validated ? { expectedCanonical: canonicalJson({ value: 1, nested: { a: 2, b: 3 } }) } : {}),
      }))).toEqual({ status: "refused", error: publicError("unavailable", 503, "release_timed_out", "retry") });
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it.each<[string, () => unknown]>([
    ["NaN", () => NaN], ["infinity", () => Infinity], ["negative infinity", () => -Infinity],
    ["promise", () => Promise.reject(new Error("late secret"))],
    ["thenable", () => ({ then(_resolve: unknown, reject: (error: unknown) => void) { reject(new Error("late secret")); } })],
  ])("refuses a %s clock answer immediately before commit", async (_name, answer) => {
    const { world, alice, operation } = fixture();
    const now = vi.fn(() => answer() as number).mockImplementationOnce(() => world.clock.now);
    const releasing = new OperationRunner({ ...world.runtime(), now });
    const commit = vi.fn();
    expect(await releasing.readRelease(operation, alice.context, {}, options(commit)))
      .toEqual({ status: "refused", error: publicError("unavailable", 503, "release_timed_out", "retry") });
    expect(now).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it("stays committed when the deadline is reached only after commit returns", async () => {
    const { world, runner, alice, operation } = fixture();
    const deadline = world.clock.now + 10;
    const original = world.admission.run.bind(world.admission);
    const commit = vi.fn(() => { expect(world.clock.now).toBeLessThan(deadline); });
    world.admission.run = (callback, opts) => original(() => {
      const result = callback();
      expect(commit).toHaveBeenCalledTimes(1);
      world.clock.now = deadline;
      return result;
    }, opts);
    expect(await runner.readRelease(operation, alice.context, {}, options(commit, { deadline }))).toEqual({ status: "committed" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(world.clock.now).toBe(deadline);
  });

  it("reruns session.describe after a grant is removed; direct release drops the project, buffered release refuses", async () => {
    for (const validated of [false, true]) {
      const { world, runner, alice } = setup();
      const earlier = await runner.run(sessionDescribe, alice.context, {});
      if (!earlier.ok) throw new Error("fixture read failed");
      expect(earlier.value.projects.map(p => p.projectId)).toEqual([projectA]);
      const gated = gatedAdmission(world);
      const releasing = new OperationRunner({ ...world.runtime(), admission: gated.admission });
      const commit = vi.fn();
      const pending = releasing.readRelease(sessionDescribe, alice.context, {}, options(commit,
        validated ? { expectedCanonical: canonicalJson(earlier.value) } : {}));
      world.grants.revokeAll(alice.id);
      gated.open();
      expect(await pending).toEqual(validated
        ? { status: "refused", error: publicError("conflict", 409, "release_payload_changed") }
        : { status: "committed" });
      if (validated) expect(commit).not.toHaveBeenCalled();
      else {
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit.mock.calls[0][0].projects).toEqual([]);
        expect(commit.mock.calls[0][0]).not.toEqual(earlier.value);
      }
    }
  });

  it.each(["credential", "generation", "eligibility", "deadline", "connection", "abort"] as const)(
    "refuses %s changed after an earlier read and before release admission", async change => {
      const { world, runner, alice, operation } = fixture();
      const earlier = await runner.run(operation, alice.context, {});
      if (!earlier.ok) throw new Error("fixture read failed");
      const gated = gatedAdmission(world);
      const releasing = new OperationRunner({ ...world.runtime(), admission: gated.admission });
      const commit = vi.fn();
      const controller = new AbortController();
      let eligible = true, connected = true;
      const deadline = world.clock.now + 10;
      const pending = releasing.readRelease(operation, alice.context, {}, options(commit, {
        eligible: () => eligible, connected: () => connected, deadline, signal: controller.signal,
        expectedCanonical: canonicalJson(earlier.value),
      }));
      if (change === "credential") world.verifier.revoke("provider_session", alice.credentialId);
      if (change === "generation") world.verifier.update("provider_session", alice.credentialId,
        current => ({ ...current, identity: { ...current.identity, generation: current.identity.generation + 1 } }));
      if (change === "eligibility") eligible = false;
      if (change === "deadline") world.clock.now = deadline;
      if (change === "connection") connected = false;
      if (change === "abort") controller.abort();
      gated.open();
      const expected = change === "credential" || change === "generation"
        ? publicError("unauthenticated", 401, "credential_no_longer_valid", "reauthenticate")
        : change === "eligibility" ? publicError("unavailable", 503, "release_not_eligible")
          : change === "deadline" ? publicError("unavailable", 503, "release_timed_out", "retry")
            : publicError("unavailable", 503, "request_cancelled", "retry");
      expect(await pending).toEqual({ status: "refused", error: expected });
      expect(commit).not.toHaveBeenCalled();
    });

  it("validates equal data regardless of object key order, but refuses changed or added fields", async () => {
    const { runner, alice, operation } = fixture();
    const earlier = await runner.run(operation, alice.context, {});
    if (!earlier.ok) throw new Error("fixture read failed");
    const cases: [unknown, boolean][] = [
      [earlier.value, true],
      [{ nested: { b: 3, a: 2 }, value: 1 }, true],
      [{ value: 2, nested: { a: 2, b: 3 } }, false],
      [{ ...earlier.value, added: true }, false],
    ];
    for (const [payload, equal] of cases) {
      const commit = vi.fn();
      expect(await runner.readRelease(operation, alice.context, {}, options(commit, { expectedCanonical: canonicalJson(payload) })))
        .toEqual(equal ? { status: "committed" } : { status: "refused", error: publicError("conflict", 409, "release_payload_changed") });
      expect(commit).toHaveBeenCalledTimes(equal ? 1 : 0);
    }
    // The option is canonical text, not arbitrary JSON. Noncanonical input is a mismatch.
    const commit = vi.fn();
    expect(await runner.readRelease(operation, alice.context, {}, options(commit, { expectedCanonical: JSON.stringify(earlier.value) })))
      .toEqual({ status: "refused", error: publicError("conflict", 409, "release_payload_changed") });
    expect(commit).not.toHaveBeenCalled();
  });

  const noAnswers: [string, () => unknown][] = [
    ["false", () => false], ["number", () => 1], ["undefined", () => undefined],
    ["throw", () => { throw new OperationError("forbidden", "private_detail"); }],
    ["promise", () => Promise.reject(new Error("late secret"))],
    ["thenable", () => ({ then(_resolve: unknown, reject: (error: unknown) => void) { reject(new Error("late secret")); } })],
  ];
  for (const field of ["eligible", "connected"] as const) {
    it.each(noAnswers)(`${field}: %s gives no synchronous true`, async (_name, predicate) => {
      const { runner, alice, operation } = fixture();
      const commit = vi.fn();
      operation.read = vi.fn(operation.read);
      expect(await runner.readRelease(operation, alice.context, {}, options(commit, { [field]: predicate as () => boolean })))
        .toEqual({ status: "refused", error: field === "eligible"
          ? publicError("unavailable", 503, "release_not_eligible") : publicError("unavailable", 503, "request_cancelled", "retry") });
      expect(commit).not.toHaveBeenCalled();
      expect(operation.read).not.toHaveBeenCalled();
    });
  }

  it.each(["throw", "promise", "thenable", "throwing_then"] as const)("commit %s fails once without retry or re-read", async kind => {
    const { runner, alice, operation } = fixture();
    operation.read = vi.fn(operation.read);
    const commit = vi.fn(() => {
      if (kind === "throw") throw new OperationError("forbidden", "secret_reason");
      if (kind === "promise") return Promise.reject(new Error("late secret"));
      if (kind === "throwing_then") return Object.defineProperty({}, "then", { get() { throw new Error("secret"); } });
      return { then(_resolve: unknown, reject: (error: unknown) => void) { reject(new Error("secret")); } };
    });
    expect(await runner.readRelease(operation, alice.context, {}, options(commit)))
      .toEqual({ status: "commit_failed", error: publicError("internal", 500, "release_commit_failed") });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(operation.read).toHaveBeenCalledTimes(1);
  });

  it("a synchronous void callback may return another ordinary value; only thenables fail decision W", async () => {
    const { runner, alice, operation } = fixture();
    expect(await runner.readRelease(operation, alice.context, {}, options(() => 17))).toEqual({ status: "committed" });
  });

  it("closes the read scope before commit and permits an inherited nested admission as elsewhere", async () => {
    const { runner, alice, operation } = fixture();
    let scope!: PhaseScope;
    const read = operation.read;
    operation.read = (input, phase) => { scope = phase; return read(input, phase); };
    let nested: ReturnType<typeof runner.run> | undefined;
    const commit = vi.fn(() => {
      expect(() => scope.authorizePrincipal({ kind: "account", accountId: alice.id }, { require: authenticated() }))
        .toThrow("phase_closed");
      nested = runner.run(sessionDescribe, alice.context, {});
    });
    expect(await runner.readRelease(operation, alice.context, {}, options(commit))).toEqual({ status: "committed" });
    expect(await nested).toMatchObject({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("requires both predicates and a finite explicit deadline", async () => {
    const { runner, alice, operation } = fixture();
    for (const extra of [{ eligible: undefined }, { connected: undefined }, { deadline: undefined }, { deadline: NaN }, { deadline: Infinity }]) {
      const commit = vi.fn();
      expect(await runner.readRelease(operation, alice.context, {}, options(commit, extra as Partial<ReadReleaseOptions<Value>>)))
        .toEqual({ status: "refused", error: publicError("invalid_request", 400, "invalid_input") });
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it("refuses mutation, query and stream shapes before any operation work", async () => {
    const { runner, world, alice, operation } = fixture();
    const mutation = fakeStart(world);
    const stream = fakeStream(world, () => undefined);
    const query: QueryOperation<object, Value, Value> = { ...operation, kind: "query", plan: () => ({}), work: vi.fn(async () => operation.read({}, {} as PhaseScope)) };
    const commit = vi.fn();
    for (const wrong of [mutation.operation, query, stream.operation]) {
      expect(await runner.readRelease(wrong as typeof query, alice.context, {}, options(commit)))
        .toEqual({ status: "refused", error: publicError("internal", 500, "invalid_operation") });
    }
    expect(mutation.log.attempts).toBe(0);
    expect(stream.state.opens).toBe(0);
    expect(query.work).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

/** One table drives both normal reads and read-release, including failure order and strict release checks. */
type Fixture = ReturnType<typeof fixture>;
type Refusal = { name: string; change(f: Fixture): void; raw?: unknown; options?: RunOptions; reason: string };
const late = () => Promise.reject(new Error("private late failure")) as never;
const refusals: Refusal[] = [
  { name: "unminted context", change: f => { f.alice.context = {} as AuthenticationContext; }, reason: "unrecognized_context" },
  { name: "revoked credential", change: f => f.world.verifier.revoke("provider_session", f.alice.credentialId), reason: "credential_no_longer_valid" },
  { name: "closed listener", change: f => { f.world.listenerOpen.value = false; }, reason: "listener_closed" },
  { name: "excluded listener before parse", change: f => { f.operation.excludedListeners = ["api"]; f.operation.parse = () => { throw new Error("must not run"); }; }, reason: "operation_not_registered" },
  { name: "invalid request", change: f => { f.operation.parse = () => { throw new Error("secret"); }; }, reason: "invalid_input" },
  { name: "parse thenable", change: f => { f.operation.parse = late; }, reason: "parse_not_synchronous" },
  { name: "resource callback thenable", change: f => { f.operation.resources = late; }, reason: "resources_not_synchronous" },
  { name: "missing resource", change: f => { f.operation.resources = () => ({ registration: { kind: "registration", id: "missing" } }); }, reason: "resource_not_found" },
  { name: "hidden resource", change: f => { f.world.grants.revokeAll(f.alice.id); f.operation.resources = () => ({ registration: REGISTRATION }); f.operation.requirement = { require: onProject("runtime:control", "registration") }; }, reason: "resource_not_found" },
  { name: "visible forbidden resource", change: f => { f.operation.resources = () => ({ registration: REGISTRATION }); f.operation.requirement = { require: onProject("config:write", "registration") }; }, reason: "permission_denied" },
  { name: "stale login", change: f => { f.operation.requirement = { require: authenticated(), freshLogin: true }; f.world.clock.now += FRESH_LOGIN_WINDOW_MS; }, reason: "fresh_login_required" },
  { name: "idempotency not supported", change: () => undefined, options: { idempotencyKey: "k" }, reason: "idempotency_not_supported" },
  { name: "admission busy", change: f => { f.world.admission.onAdmit = () => { throw admissionRefusal("busy"); }; }, reason: "admission_refused" },
  { name: "admission unavailable", change: f => { f.world.admission.onAdmit = () => { throw admissionRefusal("closed"); }; }, reason: "database_unavailable" },
  { name: "aborted admission", change: () => undefined, options: { signal: AbortSignal.abort() }, reason: "request_cancelled" },
  { name: "clock throws", change: f => { f.runner = new OperationRunner({ ...f.world.runtime(), now: () => { throw new Error("secret"); } }); }, reason: "unexpected_failure" },
  { name: "grants thenable", change: f => { f.runner = new OperationRunner({ ...f.world.runtime(), grants: late }); }, reason: "runtime_not_synchronous" },
  { name: "read throws", change: f => { f.operation.read = () => { throw new OperationError("gone", "fixture_gone"); }; }, reason: "fixture_gone" },
  { name: "read thenable", change: f => { f.operation.read = late; }, reason: "read_not_synchronous" },
  { name: "project throws", change: f => { f.operation.project = () => { throw new Error("secret"); }; }, reason: "unexpected_failure" },
  { name: "project thenable", change: f => { f.operation.project = late; }, reason: "projection_not_synchronous" },
  { name: "unlisted key", change: f => { f.operation.project = result => ({ ...result, secret: true }); }, reason: "unlisted_public_field" },
  { name: "accessor", change: f => { f.operation.project = () => ({ get value(): number { throw new Error("never read"); }, nested: { a: 2, b: 3 } }); }, reason: "invalid_projection" },
  { name: "toJSON", change: f => { f.operation.project = result => ({ ...result, toJSON: () => ({}) }); }, reason: "invalid_projection" },
  { name: "depth limit", change: f => { let nested: unknown = null; for (let n = 0; n <= MAX_RELEASE_DEPTH; n++) nested = { nested }; f.operation.project = () => ({ value: 1, nested }) as Value; }, reason: "invalid_projection" },
  { name: "node limit", change: f => { f.operation.project = () => ({ value: 1, nested: Array(MAX_RELEASE_NODES).fill(null) }) as unknown as Value; }, reason: "invalid_projection" },
];

describe("read refusal parity", () => {
  it.each(refusals)("$name", async row => {
    const f = fixture();
    row.change(f);
    const normal = await f.runner.run(f.operation, f.alice.context, row.raw ?? {}, row.options);
    expect(normal).toMatchObject({ ok: false, error: { reason: row.reason } });
    if (normal.ok) throw new Error("expected refusal");
    const commit = vi.fn();
    expect(await f.runner.readRelease(f.operation, f.alice.context, row.raw ?? {}, options(commit, row.options)))
      .toEqual({ status: "refused", error: normal.error });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("staged refusal delivery (D2a)", () => {
  type ProjectRead = ReadOperation<{ projectId: string }, Value, Value>;
  function projectRead() {
    const f = fixture();
    const read: ProjectRead = {
      id: "fixture.project_read", kind: "read", requirement: { require: onProject("project:read", "project") },
      parse: raw => {
        const projectId = (raw as { projectId?: unknown } | null)?.projectId;
        if (typeof projectId !== "string") throw new OperationError("invalid_request", "invalid_project_id");
        return { projectId };
      },
      resources: input => ({ project: { kind: "project", id: input.projectId } }),
      read: () => ({ value: 1, nested: { a: 2, b: 3 } }), project: value => value, publicKeys: ["value", "nested"],
    };
    const bob = f.world.human("bob");
    return { ...f, read, bob };
  }
  const delivery = (world: ReturnType<typeof setup>["world"], during: () => void = () => undefined) => {
    const log = { staged: [] as unknown[], committed: [] as unknown[], admittedStage: [] as boolean[], admittedCommit: [] as boolean[] };
    return { log, refusal: {
      async stage(error: unknown) { log.admittedStage.push(world.admission.admitted); log.staged.push(error); during(); },
      commit(error: unknown) { log.admittedCommit.push(world.admission.admitted); log.committed.push(error); },
    } };
  };

  it("stages a refusal outside admission and commits it inside a fresh phase that reproduces it", async () => {
    const f = projectRead(), { log, refusal } = delivery(f.world), commit = vi.fn();
    expect(await f.runner.readRelease(f.read, f.bob.context, { projectId: "project-a" }, options(commit, { refusal }))).toEqual({ status: "committed" });
    expect(log).toEqual({ staged: [publicError("not_found", 404, "resource_not_found")], committed: [publicError("not_found", 404, "resource_not_found")],
      admittedStage: [false], admittedCommit: [true] });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected promise", () => Promise.reject(new Error("private"))],
    ["rejecting thenable", () => ({ then(_resolve: unknown, reject: (err: Error) => void) { reject(new Error("private")); } })],
    ["throwing then getter", () => ({ get then() { throw new Error("private"); } })],
  ] as const)("rejects a refusal commit returning a %s without retrying", async (_name, result) => {
    const f = projectRead();
    const { log, refusal } = delivery(f.world);
    const commit = vi.fn(() => result());
    const success = vi.fn();
    const released = await f.runner.readRelease(f.read, f.bob.context, { projectId: "project-a" },
      options(success, { refusal: { stage: refusal.stage, commit } }));
    expect(released).toEqual({ status: "commit_failed", error: publicError("internal", 500, "release_commit_failed") });
    expect(log.staged).toEqual([publicError("not_found", 404, "resource_not_found")]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
  });

  it("commits the same refusal when only unrelated authority changed while staging", async () => {
    const f = projectRead();
    const { log, refusal } = delivery(f.world, () => { f.world.grants.grant({ accountId: f.bob.id, role: "reader", scope: { kind: "project", projectId: P("project-b") } }); });
    expect(await f.runner.readRelease(f.read, f.bob.context, { projectId: "project-a" }, options(vi.fn(), { refusal }))).toEqual({ status: "committed" });
    expect(log.committed).toEqual([publicError("not_found", 404, "resource_not_found")]);
  });

  it("commits nothing when the fresh phase answers differently: a success is a payload change, another refusal is returned", async () => {
    const granted = projectRead();
    const allowed = delivery(granted.world, () => { granted.world.grants.grant({ accountId: granted.bob.id, role: "reader", scope: { kind: "project", projectId: projectA } }); });
    expect(await granted.runner.readRelease(granted.read, granted.bob.context, { projectId: "project-a" }, options(vi.fn(), { refusal: allowed.refusal })))
      .toEqual({ status: "refused", error: publicError("conflict", 409, "release_payload_changed") });
    expect(allowed.log.committed).toEqual([]);

    const visible = projectRead();
    const other = delivery(visible.world, () => { visible.world.grants.grant({ accountId: visible.bob.id, role: "secrets", scope: { kind: "project", projectId: projectA } }); });
    expect(await visible.runner.readRelease(visible.read, visible.bob.context, { projectId: "project-a" }, options(vi.fn(), { refusal: other.refusal })))
      .toEqual({ status: "refused", error: publicError("forbidden", 403, "permission_denied") });
    expect(other.log.committed).toEqual([]);
  });

  it("stages an input refusal after the authority checks, and never stages a release-policy refusal", async () => {
    const f = projectRead(), input = delivery(f.world);
    expect(await f.runner.readRelease(f.read, f.bob.context, {}, options(vi.fn(), { refusal: input.refusal }))).toEqual({ status: "committed" });
    expect(input.log.committed).toEqual([publicError("invalid_request", 400, "invalid_project_id")]);
    for (const extra of [{ eligible: () => false }, { connected: () => false }, { deadline: f.world.clock.now - 1 }]) {
      const policy = delivery(f.world);
      const result = await f.runner.readRelease(f.read, f.bob.context, { projectId: "project-a" }, options(vi.fn(), { ...extra, refusal: policy.refusal }));
      expect(result.status, JSON.stringify(Object.keys(extra))).toBe("refused");
      expect(policy.log.staged).toEqual([]);
    }
  });

  it("refuses a malformed delivery or one combined with expectedCanonical before any phase", async () => {
    const f = projectRead(), { refusal } = delivery(f.world);
    for (const extra of [{ refusal: { stage: async () => undefined } }, { refusal, expectedCanonical: "{}" }]) {
      expect(await f.runner.readRelease(f.read, f.alice.context, { projectId: "project-a" }, options(vi.fn(), extra as never)))
        .toEqual({ status: "refused", error: publicError("invalid_request", 400, "invalid_input") });
    }
  });

  it("reports a failing stage as its own refusal and commits nothing", async () => {
    const f = projectRead(), committed = vi.fn();
    const refusal = { stage: async () => { throw new OperationError("payload_too_large", "response_too_large"); }, commit: committed };
    expect(await f.runner.readRelease(f.read, f.bob.context, { projectId: "project-a" }, options(vi.fn(), { refusal })))
      .toMatchObject({ status: "refused", error: { reason: "response_too_large" } });
    expect(committed).not.toHaveBeenCalled();
  });
});
