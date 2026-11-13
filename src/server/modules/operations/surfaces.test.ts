import { describe, expect, it } from "vitest";
import type { ListenerKind } from "@/shared/contracts/operations";
import { OperationRegistry, type MutationOperation, type StreamOperation } from "./operation";
import { createWorld, P, presented } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner } from "./runner";

/**
 * Listener-level surface exclusion (owner decision `fb1567d5`):
 * `claim.force_release` and `runtime.force_stop` are never registered on MCP,
 * in any mode. In open and token mode the dashboard and MCP share the
 * installation actor, so only the listener can tell them apart.
 */
const projectA = P("project-a");
const CLAIM = { kind: "claim" as const, id: "claim-1" };

function world() {
  const fixture = createWorld();
  fixture.resolver.addProject(projectA).put(CLAIM, projectA, { kind: "claim", holder: null });
  fixture.verifier.register(null, "anonymous_installation", "anonymous", { kind: "installation" });
  return fixture;
}

function forceRelease(log: { parsed: number; effects: number }): MutationOperation<{ claimId: string }, { released: boolean }, { released: boolean }> {
  return {
    id: "fixture.claim_force_release", kind: "mutation",
    requirement: { require: onProject("runtime:administer", "claim"), agents: false },
    excludedListeners: ["mcp"],
    parse: raw => { log.parsed++; return { claimId: String((raw as { claimId: string }).claimId) }; },
    resources: value => ({ claim: { kind: "claim", id: value.claimId } }),
    effect: { mode: "admitted", run: () => { log.effects++; return { released: true }; } },
    retain: true, publicKeys: ["released"], project: value => value,
  };
}

describe("listener exclusion in the registry", () => {
  it("lets transports check availability per listener", () => {
    const registry = new OperationRegistry();
    const registered = registry.register(forceRelease({ parsed: 0, effects: 0 }));
    registry.register({ ...forceRelease({ parsed: 0, effects: 0 }), id: "fixture.claim_release", excludedListeners: undefined });
    expect(registered.excludedListeners).toEqual(["mcp"]);
    expect(Object.isFrozen(registered.excludedListeners)).toBe(true);
    for (const listener of ["api", "unix", "offline", "worker"] as ListenerKind[]) expect(registry.availableOn("fixture.claim_force_release", listener)).toBe(true);
    expect(registry.availableOn("fixture.claim_force_release", "mcp")).toBe(false);
    expect(registry.idsOn("mcp")).toEqual(["fixture.claim_release"]);
    expect(registry.idsOn("api")).toEqual(["fixture.claim_force_release", "fixture.claim_release"]);
    expect(registry.availableOn("fixture.unknown", "api")).toBe(false);
  });

  it("rejects malformed exclusions", () => {
    for (const excludedListeners of [["mcp", "mcp"], ["websocket"], "mcp", [null]]) {
      expect(() => new OperationRegistry().register({ ...forceRelease({ parsed: 0, effects: 0 }), excludedListeners } as never)).toThrow(TypeError);
    }
  });
});

describe("listener exclusion in the runner", () => {
  it("refuses the same installation actor on MCP and serves it on the dashboard's API, in open and token mode", async () => {
    for (const mode of ["open", "token"] as const) {
      const fixture = world();
      const runner = new OperationRunner(fixture.runtime());
      const mint = (listener: "api" | "mcp") => (mode === "open"
        ? fixture.boundary("open", listener).mint(presented())
        : fixture.installation(listener).context);
      const log = { parsed: 0, effects: 0 };
      expect(await runner.run(forceRelease(log), mint("mcp"), { claimId: CLAIM.id }), mode)
        .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "operation_not_registered", retry: "none", effect: "not_started" } });
      // Refused before the input is parsed: malformed input on MCP learns nothing either.
      expect(await runner.run(forceRelease(log), mint("mcp"), "not even an object"), mode)
        .toMatchObject({ ok: false, error: { reason: "operation_not_registered" } });
      expect(log).toEqual({ parsed: 0, effects: 0 });
      expect(await runner.run(forceRelease(log), mint("api"), { claimId: CLAIM.id }), mode).toEqual({ ok: true, value: { released: true }, replayed: false });
      expect(log.effects).toBe(1);
    }
  });

  it("serves the unix-socket operator and refuses an agent on its own flag", async () => {
    const fixture = world();
    const runner = new OperationRunner(fixture.runtime());
    expect(await runner.run(forceRelease({ parsed: 0, effects: 0 }), fixture.operator(), { claimId: CLAIM.id })).toMatchObject({ ok: true });
    const robot = fixture.agent("robot", "api");
    fixture.grants.grant({ accountId: robot.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(forceRelease({ parsed: 0, effects: 0 }), robot.context, { claimId: CLAIM.id }))
      .toMatchObject({ ok: false, error: { category: "forbidden" } });
  });

  it("refuses an excluded stream before it opens", async () => {
    const fixture = world();
    let opened = 0;
    const stream: StreamOperation<object, { n: number }, { n: number }> = {
      id: "fixture.excluded_stream", kind: "stream", requirement: { require: onProject("project:read", "project") }, excludedListeners: ["mcp"],
      parse: () => ({}), resources: () => ({ project: { kind: "project", id: projectA } }),
      open: () => { opened++; return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }; },
      publicKeys: ["n"], projectEvent: event => event,
    };
    expect(await new OperationRunner(fixture.runtime()).stream(stream, fixture.installation("mcp").context, {}))
      .toEqual({ ok: false, error: { category: "not_found", status: 404, reason: "operation_not_registered", retry: "none", effect: null } });
    expect(opened).toBe(0);
  });
});
