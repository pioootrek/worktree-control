import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import type { ExclusiveConnectionOptions } from "@/server/infrastructure/sqlite/exclusive-connection";
import type { ProviderFactorOptions } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import type { ProofFaultInjection } from "../src/index";
import { loadProof, OWNER_EMAIL, OWNER_PASSWORD, type SESSION_POLICY } from "./fixture";

const roots: string[] = [];
export function cleanupStrictRoots() { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function strictProof(faults: ProofFaultInjection = {}, options: ExclusiveConnectionOptions = {}, identityClock?: () => string, factors?: ProviderFactorOptions, unreleasedSessions?: number, sessionPolicy?: typeof SESSION_POLICY) {
  const root = mkdtempSync(join(tmpdir(), "auth-provider-admission-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path, undefined, options);
  const identity = new IdentityService(store, identityClock, undefined, undefined, undefined, store);
  const owner = identity.bootstrapOwnerSession();
  const ownerActor = identity.authenticateBearer(owner.token);
  store.requireAdmission();
  const run = <T>(operation: () => T | Promise<T>) => store.admission.run(operation);
  const { runtime, evidence } = await loadProof(store, faults, undefined, factors, unreleasedSessions, sessionPolicy);
  return { root, path, store, identity, owner, ownerActor, runtime, evidence, run };
}
export type StrictProof = Awaited<ReturnType<typeof strictProof>>;
/** Holds a real Better Auth transaction after its first write. Always release in finally. */
export function pauseProvisioning(f: StrictProof, faults: ProofFaultInjection, outcome: "rollback" | "commit") {
  const paused = gate(), resume = gate();
  faults.afterProvisionedUser = async () => { paused.open(); await resume.opened; if (outcome === "rollback") throw new Error("abort after write"); };
  const pending = f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" })
    .then(() => "committed", (error: unknown) => (error as { code?: string }).code ?? "failed");
  return { paused: paused.opened, resume: resume.open, pending };
}
/**
 * Pauses provisioning at its hook, then expires the borrow by advancing a fake
 * timer, so the expiry never races the password hash that precedes the hook.
 * Real timers are restored before returning. Release the hold in finally.
 */
export async function pauseThenExpire(f: StrictProof, faults: ProofFaultInjection, outcome: "rollback" | "commit", borrowTimeoutMs: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const hold = pauseProvisioning(f, faults, outcome);
    // Fail at once, not at the test timeout, if provisioning settles before its hook.
    if (!await Promise.race([hold.paused.then(() => true), hold.pending.then(() => false)])) throw new Error("Provisioning settled before its hook.");
    vi.advanceTimersByTime(borrowTimeoutMs);
    return hold;
  } finally { vi.useRealTimers(); }
}
export async function closeStrictProof(f: StrictProof) { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
