import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { IdentityService, type AuthenticatedPrincipal } from "../identity";
import { DevVaultService } from "./dev-vault-service";
import { Ed25519DevVaultOwnerVerifier, devOwnerSigningMessage } from "./owner-proof";
import type { DevVaultCommand } from "@/shared/contracts/dev-vault";

export const FAKE_DOTENV = "FAKE_DEV_KEY_NAME=FAKE_DEV_ONLY_VALUE_987654321";
export function vaultFixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-vault-"));
  const path = join(root, "state.sqlite3");
  let now = "2026-10-27T12:00:00.000Z";
  let fence: string | null = null;
  let store = new SqliteStateStore(path);
  let identity = new IdentityService(store, () => now);
  const ownerToken = identity.bootstrapOwnerSession().token;
  const owner = identity.authenticateBearer(ownerToken);
  const project = store.addProject({ name: "Fake DEV fixture", repositoryPath: root, port: 3987, executable: "node", args: ["dev"] });
  const otherProject = store.addProject({ name: "Other fake DEV fixture", repositoryPath: join(root, "other"), port: 3988, executable: "node", args: ["dev"] });
  const key = randomBytes(32);
  const pair = generateKeyPairSync("ed25519");
  const verifier = new Ed25519DevVaultOwnerVerifier(() => pair.publicKey);
  let vault = new DevVaultService(store.devVault, { key: () => key }, identity, verifier, () => now, undefined, () => fence);
  function agent() {
    const principal = identity.createAgent(owner);
    const token = identity.issueAgentToken({ principalId: principal.id, label: "Fake fixture token" }, owner).token;
    return { token, actor: identity.authenticateBearer(token) };
  }
  const first = agent(), second = agent();
  function command(input: Record<string, unknown>): DevVaultCommand {
    return { projectId: project.id, operationId: randomUUID(), environment: "DEV", ...input } as DevVaultCommand;
  }
  function proof(command: DevVaultCommand, actor: AuthenticatedPrincipal = owner, issuedAt = now) {
    return { issuedAt, signature: sign(null, devOwnerSigningMessage(command, actor, issuedAt), pair.privateKey).toString("base64") };
  }
  function execute(input: Record<string, unknown>, actor = owner): unknown {
    const cmd = "operationId" in input ? input as DevVaultCommand : command(input);
    return vault.execute({ command: cmd, ...(actor === owner ? { proof: proof(cmd) } : {}) }, actor).result;
  }
  const importedResult = execute({ operation: "import", dotenv: FAKE_DOTENV }) as { profileId: string; revision: number };
  const imported = { profileId: importedResult.profileId, revision: importedResult.revision };
  function request(permission: "read" | "write" | "use", input: Record<string, unknown> = {}, actor = first.actor) {
    return execute({ operation: "request", ...imported, permission, ...input }, actor) as { id: string; revision: number };
  }
  function approve(request: { id: string; revision: number }, lifetime: "once" | "15-minutes" | "until-revoked" = "once") {
    return execute({ operation: "approve", requestId: request.id, revision: request.revision, lifetime }) as { id: string };
  }
  return { root, path, project, otherProject, owner, ownerToken, first, second, key, pair, verifier, command, proof, execute, imported, request, approve,
    get store() { return store; }, get identity() { return identity; }, get vault() { return vault; }, get now() { return now; },
    advance(ms: number) { now = new Date(Date.parse(now) + ms).toISOString(); },
    restoreFence() { fence = now; },
    reopen() {
      store.close(); store = new SqliteStateStore(path); identity = new IdentityService(store, () => now);
      vault = new DevVaultService(store.devVault, { key: () => key }, identity, verifier, () => now, undefined, () => fence);
    },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
