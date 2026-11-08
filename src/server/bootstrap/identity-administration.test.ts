import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../sqlite-store";
import { IdentityService } from "../modules/identity";
import { createProtectedIdentityAdministration } from "./identity-administration";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
describe("protected current-owner identity administration", () => {
  it("revokes immediately on the same connection and rejects agent credentials, stale owner sessions and caller authority flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "protected-identity-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanup.push(() => store.close());
    const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
    const owner = identity.bootstrapOwnerSession(), actor = identity.authenticateBearer(owner.token);
    const agent = identity.createAgent(actor), issued = identity.issueAgentToken({ principalId: agent.id, label: "scoped" }, actor);
    const execute = createProtectedIdentityAdministration(store, () => false);
    const input = { action: "revoke-token", credentialId: issued.credential.id };
    await expect(execute({ command: "identity-admin", token: issued.token, input })).rejects.toThrow("owner credential");
    await expect(execute({ command: "identity-admin", token: owner.token, input, ready: true })).rejects.toThrow("Invalid identity");
    expect(await execute({ command: "identity-admin", token: owner.token, input })).toEqual({ revoked: true });
    expect(() => identity.authenticateBearer(issued.token)).toThrow();
    identity.revokeCredential(owner.credential.id, actor);
    await expect(execute({ command: "identity-admin", token: owner.token, input })).rejects.toThrow();
  });
});
