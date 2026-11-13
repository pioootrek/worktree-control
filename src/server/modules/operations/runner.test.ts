import { describe, expect, it } from "vitest";
import { FRESH_LOGIN_WINDOW_MS, type ProjectId } from "@/shared/contracts/operations";
import type { AuthenticationContext } from "./authentication-context";
import { OperationError } from "./errors";
import type { PhaseScope, ReadOperation } from "./operation";
import { admissionRefusal } from "./operations-fixture";
import { allOf, onProject, type OperationRequirement } from "./requirements";
import { OperationRunner } from "./runner";
import {
  collect, deferred, fakeStart, fakeStream, gatedAdmission, input, key, manualStream, projectA, projectB, REGISTRATION, setup, tick,
  type EventOperation, type ProjectEvent, type StartInput, type StartInternal,
} from "./runner-fixture";

describe("operation runner: effects", () => {
  it("runs check, wait, effect, finalization and release in order", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const result = await runner.run(operation, alice.context, input);
    expect(result).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: false });
    expect(log).toMatchObject({ effects: ["start project-a"], audit: ["started 4242"], lockHeld: false, lockReleases: 1 });
    expect(JSON.stringify(result)).not.toContain("pid-secret");
  });

  it("revocation during the lock wait prevents the effect", async () => {
    for (const revoke of ["grants", "credential"] as const) {
      const { world, alice, runner } = setup();
      const lock = deferred();
      const { operation, log } = fakeStart(world, { lockWait: lock.promise });
      const pending = runner.run(operation, alice.context, input);
      await tick();
      if (revoke === "grants") world.grants.revokeAll(alice.id); else world.verifier.revoke("provider_session", alice.credentialId);
      lock.resolve();
      const result = await pending;
      expect(result).toEqual({ ok: false, error: revoke === "grants"
        ? { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" }
        : { category: "unauthenticated", status: 401, reason: "credential_no_longer_valid", retry: "reauthenticate", effect: "not_started" } });
      expect(log.effects).toEqual([]);
      expect(log.audit).toEqual([]);
      expect(log.lockHeld).toBe(false);
    }
  });

  it("revocation just before the effect prevents it, even without a wait", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    // Event 1 is the initial admission; event 2 the recheck admitting the effect.
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    const result = await runner.run(operation, alice.context, input);
    expect(result).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(log.effects).toEqual([]);
  });

  it("revocation after the effect completes finalization but withholds the result", async () => {
    for (const revoke of ["grants", "credential", "visible-but-denied"] as const) {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world, {
        duringEffect: () => {
          if (revoke === "grants") world.grants.revokeAll(alice.id);
          else if (revoke === "credential") world.verifier.revoke("provider_session", alice.credentialId);
          else {
            world.grants.revokeAll(alice.id);
            world.grants.grant({ accountId: alice.id, role: "reader", scope: { kind: "project", projectId: projectA } });
          }
        },
      });
      const result = await runner.run(operation, alice.context, input);
      expect(log.effects).toEqual(["start project-a"]);
      expect(log.audit).toEqual(["started 4242"]);
      expect(log.lockHeld).toBe(false);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatchObject({ effect: "committed", retry: "none" });
      expect(result.error.category).toBe(revoke === "grants" ? "not_found" : revoke === "credential" ? "unauthenticated" : "forbidden");
      expect(JSON.stringify(result)).not.toMatch(/pid|4242|project-a/);
    }
  });

  it("re-resolves a registration moved during the wait", async () => {
    for (const destinationRights of [false, true]) {
      const { world, alice, runner } = setup();
      if (destinationRights) world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
      const lock = deferred();
      const { operation, log } = fakeStart(world, { lockWait: lock.promise });
      const pending = runner.run(operation, alice.context, input);
      await tick();
      world.resolver.move(REGISTRATION, projectB);
      lock.resolve();
      expect(await pending).toMatchObject({ ok: false, error: destinationRights
        ? { category: "conflict", reason: "resource_changed", effect: "not_started" }
        : { category: "not_found", effect: "not_started" } });
      expect(log.effects).toEqual([]);
    }
  });

  it("withholds the result when the registration moves after the effect", async () => {
    const { world, alice, runner } = setup();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    const { operation, log } = fakeStart(world, { duringEffect: () => world.resolver.move(REGISTRATION, projectB) });
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed", effect: "committed" } });
    expect(log.audit).toEqual(["started 4242"]);
  });

  it("checks human-only and conjunction requirements before any effect", async () => {
    const { world, runner } = setup();
    const bot = world.agent("bot");
    world.grants.grant({ accountId: bot.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const humanOnly = fakeStart(world, { requirement: { require: onProject("runtime:control", "registration"), agents: false } });
    expect(await runner.run(humanOnly.operation, bot.context, input)).toMatchObject({ ok: false, error: { category: "forbidden", reason: "human_only" } });
    const both = fakeStart(world, { requirement: { require: allOf(onProject("runtime:control", "registration"), onProject("config:write", "registration")) } });
    expect(await runner.run(both.operation, bot.context, input)).toMatchObject({ ok: false, error: { category: "forbidden", reason: "permission_denied" } });
    expect([...humanOnly.log.effects, ...both.log.effects]).toEqual([]);
  });

  it("masks an invisible resource exactly like a missing one, whatever the flags", async () => {
    const { world, runner } = setup();
    const bot = world.agent("bot");
    world.resolver.put({ kind: "registration", id: "reg-b" }, projectB);
    const humanOnly = fakeStart(world, { requirement: { require: onProject("runtime:control", "registration"), agents: false } });
    const invisible = await runner.run(humanOnly.operation, bot.context, { registrationId: "reg-b" });
    const missing = await runner.run(humanOnly.operation, bot.context, { registrationId: "reg-none" });
    expect(invisible).toEqual(missing);
    expect(invisible).toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
    expect(humanOnly.log.effects).toEqual([]);
  });

  it("re-checks fresh login before the effect and before release", async () => {
    const requirement: OperationRequirement = { require: onProject("runtime:control", "registration"), freshLogin: true };
    {
      const { world, alice, runner } = setup();
      const lock = deferred();
      const { operation, log } = fakeStart(world, { requirement, lockWait: lock.promise });
      const pending = runner.run(operation, alice.context, input);
      await tick();
      world.clock.now += FRESH_LOGIN_WINDOW_MS;
      lock.resolve();
      expect(await pending).toMatchObject({ ok: false, error: { category: "login_stale", reason: "fresh_login_required", effect: "not_started" } });
      expect(log.effects).toEqual([]);
      expect(log.lockHeld).toBe(false);
    }
    {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world, { requirement, duringEffect: () => { world.clock.now += FRESH_LOGIN_WINDOW_MS; } });
      const result = await runner.run(operation, alice.context, input);
      expect(result).toMatchObject({ ok: false, error: { category: "login_stale", effect: "committed", retry: "none" } });
      expect(log.audit).toEqual(["started 4242"]);
      expect(JSON.stringify(result)).not.toContain("project-a");
    }
  });
});

describe("operation runner: only minted contexts", () => {
  it("refuses a structurally fabricated or copied context without any effect or data", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const fabricated = {
      mode: "token", listener: "api",
      revalidate: () => ({ actor: { kind: "installation" }, mode: "token", listener: "api", evidence: null, coordinationSession: null }),
      toJSON: () => { throw new TypeError("never"); },
    } as unknown as AuthenticationContext;
    const derived = [
      fabricated,
      { ...alice.context, revalidate: () => alice.context.revalidate() } as unknown as AuthenticationContext,
      Object.create(alice.context) as AuthenticationContext,
      new Proxy(alice.context, {}),
    ];
    for (const context of derived) {
      expect(await runner.run(operation, context, input)).toEqual({ ok: false, error: {
        category: "unauthenticated", status: 401, reason: "unrecognized_context", retry: "reauthenticate", effect: "not_started" } });
      const opened = await runner.stream(fakeStream(world, () => undefined).operation, context, { projectId: projectA });
      expect(opened).toMatchObject({ ok: false, error: { category: "unauthenticated", reason: "unrecognized_context" } });
    }
    expect(log.attempts).toBe(0);
    expect(log.lockReleases).toBe(0);
  });
});

describe("operation runner: idempotency", () => {
  it("re-decides before replaying a retained result", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const first = await runner.run(operation, alice.context, input, key("k-1"));
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: true });
    expect(await runner.run(operation, alice.context, { registrationId: "reg-2" }, key("k-1"))).toMatchObject({ ok: false, error: { category: "not_found" } });
    world.resolver.put({ kind: "registration", id: "reg-2" }, projectA);
    expect(await runner.run(operation, alice.context, { registrationId: "reg-2" }, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict", effect: "not_started" } });
    world.grants.revokeAll(alice.id);
    const replay = await runner.run(operation, alice.context, input, key("k-1"));
    expect(replay).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(JSON.stringify(replay)).not.toContain("project-a");
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("re-checks fresh login before a replay", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world, { requirement: { require: onProject("runtime:control", "registration"), freshLogin: true } });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    world.clock.now += FRESH_LOGIN_WINDOW_MS;
    const replay = await runner.run(operation, alice.context, input, key("k-1"));
    expect(replay).toMatchObject({ ok: false, error: { category: "login_stale", reason: "fresh_login_required" } });
    expect(JSON.stringify(replay)).not.toContain("project-a");
    expect(log.effects).toHaveLength(1);
  });

  it("does not replay another principal's retained result", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    await runner.run(operation, alice.context, input, key("shared"));
    const bob = world.human("bob");
    world.grants.grant({ accountId: bob.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, bob.context, input, key("shared"))).toMatchObject({ ok: true, replayed: false });
    expect(log.effects).toHaveLength(2);
  });

  it("refuses to replay after the resource moved, even into a project the caller may use", async () => {
    const { world, alice, runner } = setup();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    const { operation, log } = fakeStart(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    world.resolver.move(REGISTRATION, projectB);
    const replay = await runner.run(operation, alice.context, input, key("k-1"));
    expect(replay).toEqual({ ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "not_started" } });
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("refuses to replay after delete and recreate in the same project", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    world.resolver.delete(REGISTRATION);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "not_found" } });
    world.resolver.put(REGISTRATION, projectA);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed" } });
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("answers not_found when the original project is no longer visible, even if the current one is", async () => {
    const { world, alice, runner } = setup();
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectB } });
    const { operation, log } = fakeStart(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true });
    world.resolver.move(REGISTRATION, projectB);
    world.grants.grants = world.grants.grants.filter(grant => grant.scope.kind !== "project" || grant.scope.projectId !== projectA);
    const replay = await runner.run(operation, alice.context, input, key("k-1"));
    expect(replay).toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: "not_started" } });
    expect(JSON.stringify(replay)).not.toContain("project-a");
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("runs one effect for two identical requests started together", async () => {
    const { world, alice, runner, idempotency } = setup();
    const lock = deferred();
    const { operation, log } = fakeStart(world, { lockWait: lock.promise });
    // Both start in the same turn; neither has reached admission when the other is issued.
    const both = Promise.all([runner.run(operation, alice.context, input, key("k-1")), runner.run(operation, alice.context, input, key("k-1"))]);
    await tick();
    lock.resolve();
    const results = await both;
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: {
      category: "conflict", status: 409, reason: "request_in_progress", retry: "none", effect: "not_started" } }]);
    // The decisive fact: one effect and one finalization, not merely the immediate answer.
    expect(log.attempts).toBe(1);
    expect(log.effects).toEqual(["start project-a"]);
    expect(log.audit).toEqual(["started 4242"]);
    expect(idempotency.states()).toEqual(["completed"]);
  });

  it("serializes concurrent requests with one key: in progress, conflicting input, then replay", async () => {
    const { world, alice, runner } = setup();
    world.resolver.put({ kind: "registration", id: "reg-2" }, projectA);
    const lock = deferred();
    const { operation, log } = fakeStart(world, { lockWait: lock.promise });
    const first = runner.run(operation, alice.context, input, key("k-1"));
    await tick();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "conflict", status: 409, reason: "request_in_progress", retry: "none", effect: "not_started" } });
    expect(await runner.run(operation, alice.context, { registrationId: "reg-2" }, key("k-1"))).toMatchObject({ ok: false, error: {
      category: "conflict", reason: "idempotency_conflict" } });
    lock.resolve();
    expect(await first).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: true });
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("reports outcome_unknown to a retry after a first attempt of unknown outcome, without running again", async () => {
    for (const failure of ["effect", "finalization"] as const) {
      const { world, alice, runner, idempotency } = setup();
      const { operation, log } = fakeStart(world, failure === "effect"
        ? { effect: () => { throw new Error("spawn failed after fork"); } } : { finalizeThrows: true });
      const first = await runner.run(operation, alice.context, input, key("k-1"));
      expect(first).toMatchObject({ ok: false, error: { retry: "inspect_first" } });
      expect(idempotency.states()).toEqual(["unknown"]);
      expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
        category: "outcome_unknown", status: 409, reason: "previous_attempt_outcome_unknown", retry: "inspect_first", effect: "unknown" } });
      expect(log.attempts).toBe(1);
    }
  });

  it("releases the reservation of an attempt that never began, so a retry runs fresh", async () => {
    const { world, alice, runner, idempotency } = setup();
    const lock = deferred();
    const { operation, log } = fakeStart(world, { lockWait: lock.promise });
    const pending = runner.run(operation, alice.context, input, key("k-1"));
    await tick();
    expect(idempotency.states()).toEqual(["reserved"]);
    world.grants.revokeAll(alice.id);
    lock.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { category: "not_found", effect: "not_started" } });
    expect(idempotency.states()).toEqual([]);
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    expect(idempotency.states()).toEqual(["completed"]);
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("accepts keys only where idempotency is declared and stored", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const notRetained = { ...operation, retain: undefined };
    expect(await runner.run(notRetained, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "idempotency_not_supported" } });
    expect(await runner.run(operation, alice.context, input, key("bad key with spaces"))).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "invalid_idempotency_key" } });
    const withoutStore = new OperationRunner(world.runtime());
    expect(await withoutStore.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "unavailable", reason: "idempotency_unavailable", effect: "not_started" } });
    expect(log.attempts).toBe(0);
  });
});

describe("operation runner: leases", () => {
  it("releases a lease exactly once when re-admission after the acquire fails", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    world.admission.onAdmit = event => { if (event.kind === "readmit") throw admissionRefusal("busy"); };
    // The caller already holds admission, so the wait for the lock suspends and re-admits it.
    const result = await world.admission.run(() => runner.run(operation, alice.context, input));
    expect(result).toMatchObject({ ok: false, error: { category: "busy", effect: "not_started", retry: "retry" } });
    expect(log).toMatchObject({ lockHeld: false, lockReleases: 1, attempts: 0 });
  });
});

describe("operation runner: outcome-safe errors", () => {
  it("reports busy only when execution never began", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    world.admission.onAdmit = event => { if (event.n === 1) throw admissionRefusal("busy"); };
    expect(await runner.run(operation, alice.context, input)).toEqual({ ok: false, error: {
      category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: "not_started" } });
    world.admission.events = [];
    world.admission.onAdmit = event => { if (event.n === 2) throw admissionRefusal("busy"); };
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: { category: "busy", effect: "not_started" } });
    expect(log.effects).toEqual([]);
  });

  it("never reports busy after the effect began", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world, {
      duringEffect: () => { world.admission.onAdmit = () => { throw admissionRefusal("busy"); }; },
    });
    const result = await runner.run(operation, alice.context, input);
    expect(log.effects).toEqual(["start project-a"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).not.toBe("busy");
    expect(result.error.retry).not.toBe("retry");
    expect(result.error).toMatchObject({ category: "unavailable", effect: "cleanup_unconfirmed", retry: "inspect_first" });
  });

  it("finalizes and reports outcome_unknown when an effect fails untyped", async () => {
    for (const shape of ["async", "sync"] as const) {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world);
      const failing: typeof operation = { ...operation, effect: { mode: "idle", run: shape === "async"
        ? async () => { throw new Error("spawn failed after fork"); }
        : () => { throw new Error("thrown before a promise existed"); } } };
      const result = await runner.run(failing, alice.context, input);
      expect(result).toEqual({ ok: false, error: {
        category: "outcome_unknown", status: 409, reason: "effect_interrupted", retry: "inspect_first", effect: "unknown" } });
      expect(JSON.stringify(result)).not.toMatch(/spawn|thrown/);
      expect(log.audit).toEqual(["failed"]);
      expect(log.lockHeld).toBe(false);
    }
  });

  it("reports any typed error thrown by an effect as outcome_unknown, keeping its reason", async () => {
    for (const thrown of [
      new OperationError("conflict", "port_in_use", { effect: "not_started" }),
      new OperationError("busy", "worker_busy"),
      new OperationError("internal", "spawn_failed", { effect: "committed" }),
      // Already carrying the observed effect: still normalized (decision I), never released as `conflict`.
      new OperationError("conflict", "port_in_use_unknown", { effect: "unknown" }),
    ]) {
      const { world, alice, runner } = setup();
      const { operation, log } = fakeStart(world);
      const failing: typeof operation = { ...operation, effect: { mode: "idle", run: async () => { throw thrown; } } };
      expect(await runner.run(failing, alice.context, input)).toEqual({ ok: false, error: {
        category: "outcome_unknown", status: 409, reason: thrown.reason, retry: "inspect_first", effect: "unknown" } });
      expect(log.audit).toEqual(["failed"]);
    }
  });

  it("keeps a typed release denial with the committed effect it followed", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    const denied = { ...operation, project: (): never => { throw new OperationError("busy", "projector_busy"); } };
    expect(await runner.run(denied, alice.context, input)).toEqual({ ok: false, error: {
      category: "unavailable", status: 503, reason: "projector_busy", retry: "none", effect: "committed" } });
  });

  it("reports unconfirmed cleanup when finalization fails", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world, { finalizeThrows: true });
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: false, error: {
      category: "unavailable", reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed", retry: "inspect_first" } });
  });

  it("refuses to release unlisted fields, the authentication context or a toJSON bypass", async () => {
    const { world, alice, runner } = setup();
    const { operation, log } = fakeStart(world);
    const extra = { ...operation, project: (result: StartInternal) => ({ projectId: result.projectId, started: true, pid: result.pid }) };
    expect(await runner.run(extra, alice.context, input)).toMatchObject({ ok: false, error: { category: "internal", reason: "unlisted_public_field", effect: "committed" } });
    const leak = { ...operation, project: () => ({ projectId: alice.context as unknown as ProjectId, started: true }) };
    expect(await runner.run(leak, alice.context, input)).toMatchObject({ ok: false, error: { category: "internal", effect: "committed" } });
    const hidden = { ...operation, project: (result: StartInternal) => {
      const value = { projectId: result.projectId, started: true };
      Object.defineProperty(value, "toJSON", { enumerable: false, value: () => ({ projectId: result.projectId, started: true, processSecret: result.processSecret }) });
      return value;
    } };
    // Own keys are exactly the allowlist, so only the inherited toJSON could add the secret: an allowlist check alone would pass it.
    const inherited = { ...operation, project: (result: StartInternal) => Object.assign(
      Object.create({ toJSON: () => ({ projectId: result.projectId, started: true, processSecret: result.processSecret }) }) as object,
      { projectId: result.projectId, started: true }) as { projectId: ProjectId; started: boolean } };
    expect(Object.keys(inherited.project({ projectId: projectA, pid: 1, processSecret: "s" })).sort()).toEqual(["projectId", "started"]);
    for (const bypass of [hidden, inherited]) {
      const result = await runner.run(bypass, alice.context, input);
      expect(result).toMatchObject({ ok: false, error: { category: "internal", reason: "invalid_projection", effect: "committed" } });
      expect(JSON.stringify(result)).not.toContain("pid-secret");
    }
    expect(log.audit).toHaveLength(4);
  });

  it("runs an admitted synchronous effect atomically with its final check", async () => {
    const { world, alice, runner } = setup();
    const writes: string[] = [];
    const { operation } = fakeStart(world);
    const write: typeof operation = { ...operation, acquire: undefined, effect: { mode: "admitted", run: (_input: StartInput, scope: PhaseScope) => {
      if (!world.admission.admitted) throw new Error("must be admitted");
      writes.push("row");
      return { projectId: scope.resources.registration.projectId, pid: 1, processSecret: "x" };
    } } };
    expect(await runner.run(write, alice.context, input)).toMatchObject({ ok: true });
    world.admission.events = [];
    world.admission.onAdmit = event => { if (event.n === 2) world.grants.revokeAll(alice.id); };
    expect(await runner.run(write, alice.context, input)).toMatchObject({ ok: false, error: { effect: "not_started" } });
    expect(writes).toEqual(["row"]);
  });

  it("maps unparseable input to invalid_request before any admission", async () => {
    const { world, alice, runner } = setup();
    const { operation } = fakeStart(world);
    const strict = { ...operation, parse: () => { throw new Error("bad"); } };
    expect(await runner.run(strict, alice.context, {})).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "invalid_input", effect: "not_started" } });
    expect(world.admission.events).toEqual([]);
  });
});

describe("operation runner: cancellation", () => {
  it("abort during the admission wait cancels a mutation before anything happens", async () => {
    const { world, alice, idempotency } = setup();
    const { admission } = gatedAdmission(world);
    const runner = new OperationRunner({ ...world.runtime({ idempotency }), admission });
    const { operation, log } = fakeStart(world);
    const abort = new AbortController();
    const pending = runner.run(operation, alice.context, input, { signal: abort.signal, idempotencyKey: "k-1" });
    await tick();
    abort.abort();
    expect(await pending).toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "request_cancelled", retry: "retry", effect: "not_started" } });
    expect(log).toMatchObject({ attempts: 0, lockReleases: 0 });
    expect(idempotency.states()).toEqual([]);
  });

  it("abort during the admission wait never opens a stream", async () => {
    const { world, alice } = setup();
    const { admission } = gatedAdmission(world);
    const runner = new OperationRunner({ ...world.runtime(), admission });
    const { operation, state } = fakeStream(world, () => undefined);
    const abort = new AbortController();
    const pending = runner.stream(operation, alice.context, { projectId: projectA }, { signal: abort.signal });
    await tick();
    abort.abort();
    expect(await pending).toEqual({ ok: false, error: { category: "unavailable", status: 503, reason: "request_cancelled", retry: "retry", effect: null } });
    // open() itself was never called (not merely a generator body that did not start).
    expect(state.opens).toBe(0);
    expect(state.opened).toBe(false);
  });
});

describe("operation runner: streams", () => {
  async function open(context: AuthenticationContext, runner: OperationRunner, operation: EventOperation, signal?: AbortSignal) {
    const opened = await runner.stream(operation, context, { projectId: projectA }, { signal });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    return opened.events;
  }

  it("authorizes and projects every event, filtering per item", async () => {
    const { world, alice, runner } = setup();
    const { operation, state } = fakeStream(world, () => undefined);
    expect(await collect(await open(alice.context, runner, operation))).toEqual([1, 3, 4, 5].map(seq => ({ event: { seq, projectId: projectA } })));
    expect(state.disposed).toBe(true);
  });

  it("ends with one error and disposes the source after revocation", async () => {
    for (const revoke of ["grants", "credential"] as const) {
      const { world, alice, runner } = setup();
      const { operation, state } = fakeStream(world, seq => {
        if (seq !== 4) return;
        if (revoke === "grants") world.grants.revokeAll(alice.id); else world.verifier.revoke("provider_session", alice.credentialId);
      });
      const items = await collect(await open(alice.context, runner, operation));
      expect(items.slice(0, 2)).toEqual([{ event: { seq: 1, projectId: projectA } }, { event: { seq: 3, projectId: projectA } }]);
      expect(items[2]).toMatchObject({ error: { category: revoke === "grants" ? "not_found" : "unauthenticated" } });
      expect(items).toHaveLength(3);
      expect(state.disposed).toBe(true);
      expect(state.produced).toBe(4);
      expect(JSON.stringify(items)).not.toMatch(/s-x|s-y|"seq":4/);
    }
  });

  it("refuses to open without authority and never opens the source", async () => {
    const { world, runner } = setup();
    const stranger = world.human("stranger");
    const { operation, state } = fakeStream(world, () => undefined);
    expect(await runner.stream(operation, stranger.context, { projectId: projectA })).toEqual({ ok: false, error: {
      category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } });
    expect(state.opens).toBe(0);
  });

  it("disposes the source when the consumer stops early", async () => {
    const { world, alice, runner } = setup();
    const { operation, state } = fakeStream(world, () => undefined);
    for await (const item of await open(alice.context, runner, operation)) { expect(item).toMatchObject({ event: { seq: 1 } }); break; }
    expect(state.disposed).toBe(true);
  });

  it("releases construction failures as sanitized errors", async () => {
    const { alice, runner } = setup();
    const throwing = manualStream({ next: async () => ({ done: true, value: undefined }) }, { construct: () => { throw new Error("secret /var/lib/path"); } });
    const opened = await runner.stream(throwing, alice.context, { projectId: projectA });
    expect(opened).toEqual({ ok: false, error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null } });
    const failingOpen = { ...throwing, open: (): never => { throw new Error("secret open failure"); } };
    expect(await runner.stream(failingOpen, alice.context, { projectId: projectA })).toEqual({ ok: false, error: {
      category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null } });
  });

  it("turns next() failures into one sanitized error item and disposes once", async () => {
    for (const shape of ["reject", "throw"] as const) {
      const { alice, runner } = setup();
      let returns = 0;
      let calls = 0;
      const operation = manualStream({
        next: () => {
          calls++;
          if (calls === 1) return Promise.resolve({ done: false, value: { projectId: projectA, seq: 1, holderSession: "s" } });
          if (shape === "throw") throw new Error("secret next failure");
          return Promise.reject(new Error("secret next failure"));
        },
        return: async () => { returns++; return { done: true, value: undefined }; },
      });
      const items = await collect(await open(alice.context, runner, operation));
      expect(items).toEqual([{ event: { seq: 1, projectId: projectA } },
        { error: { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null } }]);
      expect(returns).toBe(1);
    }
  });

  it("keeps the denial when cleanup fails after it, reports the failure, and lets return() resolve done", async () => {
    const { world, alice, runner } = setup();
    let returns = 0;
    const operation = manualStream({
      next: async () => {
        world.grants.revokeAll(alice.id);
        return { done: false, value: { projectId: projectA, seq: 9, holderSession: "s" } };
      },
      return: () => { returns++; throw new Error("secret cleanup failure"); },
    });
    const items = await collect(await open(alice.context, runner, operation));
    expect(items).toEqual([{ error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect: null } }]);
    expect(returns).toBe(1);
    // Decision T: the disposal failure is reported to the observer, and nothing follows the denial.
    expect(world.disposalFailures).toEqual([{ operationId: "fixture.manual_events", kind: "rejected" }]);
    const consumer = await open(world.installation().context, runner, manualStream({
      next: async () => ({ done: false, value: { projectId: projectA, seq: 1, holderSession: "s" } }),
      return: async () => { throw new Error("secret cleanup failure"); },
    }));
    expect(await consumer.next()).toMatchObject({ done: false, value: { event: { seq: 1 } } });
    await expect(consumer.return!()).resolves.toEqual({ done: true, value: undefined });
    expect(await consumer.next()).toEqual({ done: true, value: undefined });
    expect(world.disposalFailures).toEqual([
      { operationId: "fixture.manual_events", kind: "rejected" }, { operationId: "fixture.manual_events", kind: "rejected" }]);
  });

  it("abort settles a pending read, disposes once and drops a late event", async () => {
    for (const settles of ["late", "never"] as const) {
      const { alice, runner } = setup();
      const late = deferred<IteratorResult<ProjectEvent>>();
      let returns = 0;
      let projected = 0;
      const operation = { ...manualStream({
        next: () => (settles === "late" ? late.promise : new Promise<never>(() => undefined)),
        // A source that never settles its disposal either must not hang the consumer.
        return: () => { returns++; return new Promise<never>(() => undefined); },
      }), projectEvent: (event: ProjectEvent) => { projected++; return { seq: event.seq, projectId: event.projectId }; } };
      const abort = new AbortController();
      const events = await open(alice.context, runner, operation, abort.signal);
      const pending = events.next();
      await tick();
      abort.abort();
      expect(await pending).toEqual({ done: true, value: undefined });
      late.resolve({ done: false, value: { projectId: projectA, seq: 7, holderSession: "s" } });
      await tick();
      expect(await events.next()).toEqual({ done: true, value: undefined });
      expect(returns).toBe(1);
      expect(projected).toBe(0);
    }
  });

  it("consumer return() during a pending read ends the stream without waiting for the source", async () => {
    const { alice, runner } = setup();
    let returns = 0;
    const operation = manualStream({ next: () => new Promise<never>(() => undefined), return: async () => { returns++; return { done: true, value: undefined }; } });
    const events = await open(alice.context, runner, operation);
    const pending = events.next();
    await tick();
    await events.return!();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(returns).toBe(1);
  });

  it("projects nothing after a denial", async () => {
    const { world, alice, runner } = setup();
    let projected = 0;
    const base = fakeStream(world, seq => { if (seq === 3) world.grants.revokeAll(alice.id); });
    const operation = { ...base.operation, projectEvent: (event: ProjectEvent, release: Parameters<typeof base.operation.projectEvent>[1]) => {
      projected++;
      return base.operation.projectEvent(event, release);
    } };
    const items = await collect(await open(alice.context, runner, operation));
    expect(items).toEqual([{ event: { seq: 1, projectId: projectA } }, { error: expect.objectContaining({ category: "not_found" }) }]);
    expect(projected).toBe(2);
  });
});

describe("operation runner: reads", () => {
  it("rejects an idempotency key and releases strictly", async () => {
    const { world, alice, runner } = setup();
    const read: ReadOperation<Record<string, never>, { projectId: ProjectId }, { projectId: ProjectId }> = {
      id: "fixture.read", kind: "read", requirement: { require: onProject("project:read", "registration") },
      parse: () => ({}), resources: () => ({ registration: REGISTRATION }),
      read: (_input, scope) => ({ projectId: scope.resources.registration.projectId }),
      publicKeys: ["projectId"], project: result => result,
    };
    expect(await runner.run(read, alice.context, {})).toEqual({ ok: true, value: { projectId: projectA }, replayed: false });
    expect(await runner.run(read, alice.context, {}, key("k-1"))).toMatchObject({ ok: false, error: { category: "invalid_request", reason: "idempotency_not_supported" } });
    world.resolver.put({ kind: "registration", id: "reg-b" }, projectB);
    const invisible = await runner.run({ ...read, resources: () => ({ registration: { kind: "registration", id: "reg-b" } }) }, alice.context, {});
    const missing = await runner.run({ ...read, resources: () => ({ registration: { kind: "registration", id: "reg-none" } }) }, alice.context, {});
    expect(invisible).toEqual(missing);
  });
});
