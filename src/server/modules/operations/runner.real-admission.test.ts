import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId } from "@/shared/contracts/operations";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import type { MutationOperation } from "./operation";
import { createWorld, P } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner } from "./runner";

/**
 * The runner on the real connection gate (`SqliteStateStore.admission` over a
 * temporary database), not on the admission double. Test-only: production
 * code still never imports this module.
 */
const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe("operation runner on the real admission gate", () => {
  it("releases a lease exactly once when re-admission after the acquire is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "operations-runner-")); roots.push(root);
    const store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admissionTimeoutMs: 50 });
    cleanups.push(() => store.close());
    const storage = store.authenticationProviderStorage();
    const world = createWorld();
    const projectA = P("project-a");
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const alice = world.human("alice");
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    const runner = new OperationRunner({ ...world.runtime(), admission: store.admission });

    const providerEntered = gate(), providerRelease = gate();
    let providerDone: Promise<unknown> = Promise.resolve();
    cleanups.push(async () => { providerRelease.open(); await providerDone.catch(() => undefined); });
    const log = { held: false, releases: 0, effects: 0 };
    const operation: MutationOperation<{ registrationId: string }, { projectId: ProjectId }, { projectId: ProjectId }> = {
      id: "fixture.real_gate_start",
      kind: "mutation",
      requirement: { require: onProject("runtime:control", "registration") },
      parse: raw => ({ registrationId: String((raw as { registrationId: string }).registrationId) }),
      resources: input => ({ registration: { kind: "registration", id: input.registrationId } }),
      async acquire() {
        // While the caller is suspended, a provider takes the connection and keeps it,
        // so the caller's re-admission after this acquire times out.
        providerDone = storage.borrow(async () => { providerEntered.open(); await providerRelease.opened; });
        await providerEntered.opened;
        log.held = true;
        return { release: () => { log.held = false; log.releases++; } };
      },
      effect: { mode: "idle", async run(_input, scope) { log.effects++; return { projectId: scope.resources.registration.projectId }; } },
      publicKeys: ["projectId"],
      project: result => result,
    };

    // The caller already holds admission, so the wait for the lock suspends it and must re-admit it.
    const result = await store.admission.run(() => runner.run(operation, alice.context, { registrationId: "reg-1" }));
    expect(result).toEqual({ ok: false, error: { category: "busy", status: 503, reason: "admission_refused", retry: "retry", effect: "not_started" } });
    expect(log).toEqual({ held: false, releases: 1, effects: 0 });
  });
});
