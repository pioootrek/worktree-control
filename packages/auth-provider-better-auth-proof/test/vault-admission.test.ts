import { afterEach, describe, expect, it } from "vitest";
import { DevVaultOperations } from "@/server/modules/dev-vault";
import { vaultFixture, FAKE_DOTENV } from "@/server/modules/dev-vault/test-fixture";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { ProcessManager } from "@/server/process-manager";
import { loadProof, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const f = vaultFixture(), faults: ProofFaultInjection = {};
  f.store.requireAdmission();
  const { runtime, evidence } = await loadProof(f.store, faults);
  cleanups.push(() => f.close(), () => f.store.closeAfterDrain(), () => runtime.dispose());
  const operations = new DevVaultOperations(f.vault, new ProjectLifecycle(f.store, new ProcessManager()));
  const run = <T>(op: () => T | Promise<T>) => f.store.admission.run(op);
  function hold() {
    const paused = gate(), resume = gate();
    faults.afterProvisionedUser = async () => { paused.open(); await resume.opened; throw new Error("fixture rollback"); };
    const pending = runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "fixture", password: OWNER_PASSWORD, actor: "test" }).catch(() => undefined);
    return { paused: paused.opened, resume: resume.open, pending };
  }
  return { f, operations, run, hold, evidence };
}
describe("vault freshness at strict live admission", () => {
  it("expires a previously valid owner proof while waiting without exposing plaintext", async () => {
    const { f, operations, hold, evidence } = await fixture();
    const command = f.command({ operation: "read", ...f.imported }), proof = f.proof(command);
    const pause = hold();
    try {
      await pause.paused;
      const pending = operations.execute({ command, proof }, f.owner);
      const denied = expect(pending).rejects.toMatchObject({ code: "vault_proof_expired" });
      f.advance(60_001); pause.resume(); await pause.pending; await denied;
      expect(JSON.stringify(evidence)).not.toContain(FAKE_DOTENV);
    } finally { pause.resume(); await pause.pending; }
  });

  it("rechecks a revoked read grant before returning retained plaintext replay", async () => {
    const { f, operations, run, hold, evidence } = await fixture();
    const grant = await run(() => f.approve(f.request("read"), "until-revoked"));
    const command = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    const first = await operations.execute({ command }, f.first.actor);
    expect(JSON.stringify(first)).toContain("FAKE_DEV_ONLY_VALUE_987654321");
    const pause = hold();
    try {
      await pause.paused;
      const revoke = run(() => f.execute({ operation: "revoke", grantId: grant.id }));
      const pending = operations.execute({ command }, f.first.actor);
      const denied = expect(pending).rejects.toMatchObject({ code: "vault_denied" });
      pause.resume(); await pause.pending; await revoke; await denied;
      expect(JSON.stringify(evidence)).not.toContain("FAKE_DEV_ONLY_VALUE_987654321");
    } finally { pause.resume(); await pause.pending; }
  });

  it("denies retained owner plaintext after credential revocation while queued", async () => {
    const { f, operations, run, hold } = await fixture();
    const command = f.command({ operation: "read", ...f.imported }), proof = f.proof(command);
    expect(JSON.stringify(await operations.execute({ command, proof }, f.owner))).toContain("FAKE_DEV_ONLY_VALUE_987654321");
    const pause = hold();
    try {
      await pause.paused;
      const revoke = run(() => f.identity.revokeCredential(f.owner.credentialId, f.owner));
      const denied = expect(operations.execute({ command, proof }, f.owner)).rejects.toMatchObject({ code: "vault_denied" });
      pause.resume(); await pause.pending; await revoke; await denied;
    } finally { pause.resume(); await pause.pending; }
  });
});
