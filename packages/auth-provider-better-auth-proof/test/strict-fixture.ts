import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import type { ExclusiveConnectionOptions } from "@/server/infrastructure/sqlite/exclusive-connection";
import { IdentityService } from "@/server/modules/identity";
import type { ProofFaultInjection } from "../src/index";
import { loadProof, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";

const roots: string[] = [];
export function cleanupStrictRoots() { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function strictProof(faults: ProofFaultInjection = {}, options: ExclusiveConnectionOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "auth-provider-admission-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path, undefined, options);
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const owner = identity.bootstrapOwnerSession();
  const ownerActor = identity.authenticateBearer(owner.token);
  store.requireAdmission();
  const run = <T>(operation: () => T | Promise<T>) => store.admission.run(operation);
  const { runtime, evidence } = await loadProof(store, faults);
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
export async function closeStrictProof(f: StrictProof) { await f.runtime.dispose(); await f.store.closeAfterDrain(); }
