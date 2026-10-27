import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevVaultCipher, DevVaultService, parseDevDotenv } from "./index";
import { canonicalJson } from "./crypto";
import { FAKE_DOTENV, vaultFixture } from "./test-fixture";
import { DEV_VAULT_STATE_BYTES } from "./dev-vault-service";

const fixtures: ReturnType<typeof vaultFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = vaultFixture(); fixtures.push(f); return f; }

describe("DEV dotenv data parser", () => {
  it("accepts bounded literal data without evaluating it", () => {
    expect(parseDevDotenv("# fake only\r\nFAKE='two words'\r\nEMPTY=\nOTHER=https://example.test/a?a=b")).toEqual({ FAKE: "two words", EMPTY: "", OTHER: "https://example.test/a?a=b" });
  });
  it.each(["A=1\nA=2", "export A=1", "A=$(id)", "A=${HOME}", "A=`id`", "A=one two", "A=\"unclosed", "A=one\0two", "A=one\rtwo", "A=one\\ntwo", "BAD-NAME=1", "A=1 # trailing comment", "# empty", "A=\"multi\nline\"", "__proto__=x"])("rejects unsupported/malformed input without echo (%#)", value => {
    expect(() => parseDevDotenv(value)).toThrow("vault_invalid_request");
  });
  it.each(["PORT", "NODE_ENV", "PATH", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONHOME", "DYLD_INSERT_LIBRARIES", "WORKTREE_CONTROL_TOKEN", "HOME", "BASH_ENV"])("reserves %s", name => {
    expect(() => parseDevDotenv(`${name}=fake`)).toThrow("vault_invalid_request");
  });
  it("bounds UTF-8 bytes, variables and each value", () => {
    for (const input of ["A=" + "é".repeat(17_000), "A=" + "a".repeat(8193), Array.from({ length: 101 }, (_, i) => `A${i}=x`).join("\n")]) {
      expect(() => parseDevDotenv(input)).toThrow("vault_invalid_request");
    }
  });
  it.each(["APP_ENV=production", "ENVIRONMENT=staging", "DEPLOYMENT_ENV=prod", "STAGE=stage"])("rejects explicit non-DEV classification (%#)", input => {
    expect(() => parseDevDotenv(input)).toThrow("vault_invalid_request");
  });
});

describe("authenticated encryption", () => {
  it("uses unique nonces and binds the entire payload to project/profile/revision", () => {
    const key = randomBytes(32), cipher = new DevVaultCipher({ key: () => key });
    const first = cipher.seal({ FAKE_KEY: "fake-value" }, "p", "profile", 1);
    expect(cipher.seal({ FAKE_KEY: "fake-value" }, "p", "profile", 1)).not.toEqual(first);
    expect(cipher.open(first, "p", "profile", 1)).toEqual({ FAKE_KEY: "fake-value" });
    for (const [project, profile, revision] of [["other", "profile", 1], ["p", "other", 1], ["p", "profile", 2]] as const) {
      expect(() => cipher.open(first, project, profile, revision)).toThrow("vault_unavailable");
    }
    const tampered = Buffer.from(first, "base64"); tampered[tampered.length - 1] ^= 1;
    expect(() => cipher.open(tampered.toString("base64"), "p", "profile", 1)).toThrow("vault_unavailable");
    expect(() => new DevVaultCipher({ key: () => randomBytes(32) }).open(first, "p", "profile", 1)).toThrow("vault_unavailable");
  });
});

describe("vault authorization, persistence and versioning", () => {
  it("requires a separate owner signature and never infers owner from a transport or token", () => {
    const f = fixture(), cmd = f.command({ operation: "list" });
    expect(() => f.vault.execute({ command: cmd }, f.owner)).toThrow("vault_denied");
    expect(() => f.vault.execute({ command: cmd, proof: f.proof(cmd) }, f.first.actor)).toThrow("vault_denied");
    expect(() => f.vault.execute({ command: { ...cmd, operation: "audit" }, proof: f.proof(cmd) }, f.owner)).toThrow("vault_denied");
    expect(() => f.vault.execute({ command: cmd, proof: f.proof(cmd, f.owner, "2026-10-27T11:58:00.000Z") }, f.owner)).toThrow("vault_proof_expired");
    for (const method of ["installation_token", "none"] as const) {
      const installation = { principalId: "installation", principalKind: "installation" as const, credentialId: "installation", authenticationMethod: method };
      expect(() => f.vault.execute({ command: cmd, proof: f.proof(cmd, installation) }, installation)).toThrow("vault_denied");
    }
    expect(() => f.execute({ operation: "approve", requestId: randomUUID(), revision: 1, lifetime: "once" }, f.first.actor)).toThrow("vault_denied");
  });
  it("classifies only authentic expired proofs as retryable without changing state", () => {
    const f = fixture(), cmd = f.command({ operation: "import", dotenv: FAKE_DOTENV });
    const proof = f.proof(cmd), before = f.store.devVault.load(f.project.id);
    f.advance(60_001);
    expect(f.verifier.verify(cmd, f.owner, proof, f.now)).toBe("expired");
    expect(() => f.vault.execute({ command: cmd, proof }, f.owner)).toThrow("vault_proof_expired");
    expect(f.store.devVault.load(f.project.id)).toEqual(before);
    // An old timestamp does not make a forged or differently bound signature retryable.
    for (const request of [
      { command: { ...cmd, operationId: randomUUID() }, proof },
      { command: cmd, proof: { ...proof, signature: Buffer.alloc(64).toString("base64") } },
      { command: cmd, proof: f.proof(cmd, { ...f.owner, credentialId: randomUUID() }, proof.issuedAt) },
      { command: cmd, proof: f.proof(cmd, f.owner, new Date(Date.parse(f.now) + 1).toISOString()) },
    ]) expect(() => f.vault.execute(request, f.owner)).toThrow("vault_denied");
    f.identity.revokeCredential(f.owner.credentialId, f.owner);
    expect(() => f.vault.execute({ command: cmd, proof }, f.owner)).toThrow("vault_denied");
    expect(f.store.devVault.load(f.project.id)).toEqual(before);
  });
  it("denies expired proofs for removed projects and across restore fences", () => {
    const f = fixture(), removed = f.command({ operation: "list", projectId: f.otherProject.id });
    const cmd = f.command({ operation: "list" }), proof = f.proof(cmd), removedProof = f.proof(removed);
    f.store.removeProject(f.otherProject.id, "fixture");
    f.advance(60_001);
    expect(() => f.vault.execute({ command: removed, proof: removedProof }, f.owner)).toThrow("vault_denied");
    f.restoreFence();
    expect(() => f.vault.execute({ command: cmd, proof }, f.owner)).toThrow("vault_denied");
  });
  it("defaults deny and separates project, agent and exact credential", () => {
    const f = fixture(), read = { operation: "read", ...f.imported };
    expect(() => f.execute(read, f.first.actor)).toThrow("vault_denied");
    const grant = f.approve(f.request("read"), "until-revoked");
    expect(() => f.execute({ ...read, grantId: grant.id }, f.second.actor)).toThrow("vault_denied");
    const token = f.identity.issueAgentToken({ principalId: f.first.actor.principalId, label: "Minted replacement" }, f.owner).token;
    expect(() => f.execute({ ...read, grantId: grant.id }, f.identity.authenticateBearer(token))).toThrow("vault_denied");
    expect(() => f.execute({ ...read, grantId: grant.id, projectId: f.otherProject.id }, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ ...read, grantId: grant.id }, f.first.actor)).toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
  });
  it("keeps values and names out of DB, WAL, literal project shapes, metadata and audit", () => {
    const f = fixture();
    const request = f.request("write", { dotenv: "NEW_FAKE_KEY=NEW_FAKE_VALUE", source: "inline-dotenv" });
    f.approve(request);
    const state = JSON.stringify(f.store.devVault.load(f.project.id));
    for (const value of ["FAKE_DEV_KEY_NAME", "FAKE_DEV_ONLY_VALUE_987654321", "NEW_FAKE_KEY", "NEW_FAKE_VALUE"]) {
      expect(state).not.toContain(value);
      expect(JSON.stringify(f.store.getProject(f.project.id))).not.toContain(value);
      expect(JSON.stringify(f.execute({ operation: "audit" }))).not.toContain(value);
      expect(JSON.stringify(f.execute({ operation: "requests" }, f.first.actor))).not.toContain(value);
      for (const path of [f.path, `${f.path}-wal`]) if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(value))).toBe(false);
    }
    expect(f.execute({ operation: "inspect-request", requestId: request.id })).toMatchObject({ proposal: { NEW_FAKE_KEY: "NEW_FAKE_VALUE" } });
  });
  it("applies exactly the encrypted approved patch, without read or administration authority", () => {
    const f = fixture(), r = f.request("write", { dotenv: "NEW_FAKE_KEY=NEW_FAKE_VALUE", source: "inline-dotenv" });
    const grant = f.approve(r);
    const write = f.command({ operation: "write", grantId: grant.id });
    expect(() => f.execute({ ...write, dotenv: "NEW_FAKE_KEY=changed" }, f.first.actor)).toThrow("vault_invalid_request");
    const result = f.execute(write, f.first.actor);
    expect(result).toMatchObject({ revision: 2 });
    expect(JSON.stringify(result)).not.toContain("FAKE");
    expect(f.execute(write, f.first.actor)).toEqual(result);
    expect(() => f.execute({ operation: "read", ...f.imported, revision: 2, grantId: grant.id }, f.first.actor)).toThrow("vault_denied");
    expect(() => f.execute({ operation: "write", grantId: grant.id }, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ operation: "read", ...f.imported, revision: 2 })).toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321", NEW_FAKE_KEY: "NEW_FAKE_VALUE" } });
    f.reopen(); expect(f.execute(write, f.first.actor)).toEqual(result);
  });
  it("does not let a read grant authorize writes or a write request change source", () => {
    const f = fixture(), grant = f.approve(f.request("read"));
    expect(() => f.execute({ operation: "write", grantId: grant.id }, f.first.actor)).toThrow("vault_denied");
    expect(() => f.request("write", { dotenv: "X=fake", source: "shell" })).toThrow("vault_invalid_request");
    expect(() => f.request("read", { dotenv: FAKE_DOTENV })).toThrow("vault_invalid_request");
    const cmd = f.command({ operation: "request", ...f.imported, permission: "write", dotenv: "X=fake", source: "inline-dotenv" });
    f.execute(cmd, f.first.actor);
    expect(() => f.execute({ ...cmd, dotenv: "X=different" }, f.first.actor)).toThrow("vault_conflict");
  });
  it("binds approvals to the requested/current revision and rejects stale grants", () => {
    const f = fixture(), request = f.request("read"), grant = f.approve(request);
    expect(() => f.execute({ operation: "approve", requestId: request.id, revision: 2, lifetime: "once" })).toThrow();
    f.execute({ operation: "update", ...f.imported, dotenv: "X=fake" });
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: grant.id }, f.first.actor)).toThrow("vault_conflict");
    expect(() => f.request("read")).toThrow("vault_conflict");
  });
  it("atomically consumes once, permits identical retry, and denies competing operations", async () => {
    const f = fixture(), grant = f.approve(f.request("read"));
    const first = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    const second = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    const raced = await Promise.allSettled([Promise.resolve().then(() => f.execute(first, f.first.actor)), Promise.resolve().then(() => f.execute(second, f.first.actor))]);
    expect(raced.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.execute(first, f.first.actor)).toEqual((raced[0] as PromiseFulfilledResult<unknown>).value);
    f.reopen(); expect(f.execute(first, f.first.actor)).toEqual((raced[0] as PromiseFulfilledResult<unknown>).value);
    f.execute({ operation: "revoke", grantId: grant.id });
    expect(() => f.execute(first, f.first.actor)).toThrow("vault_denied");
  });
  it("persists fifteen-minute expiry and blocks plaintext receipt replay", () => {
    const f = fixture(), grant = f.approve(f.request("read"), "15-minutes");
    const read = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    f.execute(read, f.first.actor); f.advance(15 * 60_000); f.reopen();
    expect(() => f.execute(read, f.first.actor)).toThrow("vault_denied");
  });
  it("keeps once consumption after receipt eviction and bounds audit history", () => {
    const f = fixture(), grant = f.approve(f.request("read"));
    const read = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    f.execute(read, f.first.actor);
    for (let n = 0; n < 66; n++) {
      const r = f.request("read"); f.execute({ operation: "reject", requestId: r.id });
    }
    f.reopen();
    expect(() => f.execute(read, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ operation: "audit" })).toMatchObject({ events: expect.any(Array) });
    expect((f.execute({ operation: "audit" }) as { events: unknown[] }).events).toHaveLength(128);
  });
  it("expires unused once grants and retains until-revoked grants beyond receipt retention", () => {
    const f = fixture(), once = f.approve(f.request("read")), indefinite = f.approve(f.request("read"), "until-revoked");
    f.advance(2 * 86_400_000); f.reopen();
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: once.id }, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ operation: "read", ...f.imported, grantId: indefinite.id }, f.first.actor)).toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
  });
  it("persists revocation and current credential checks across restart", () => {
    const f = fixture(), grant = f.approve(f.request("read"), "until-revoked");
    f.execute({ operation: "revoke", grantId: grant.id }); f.reopen();
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: grant.id }, f.first.actor)).toThrow("vault_denied");
    const next = f.approve(f.request("read"), "until-revoked");
    f.identity.revokeCredential(f.first.actor.credentialId, f.owner);
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: next.id }, f.first.actor)).toThrow("vault_denied");
  });
  it("can revoke near the byte cap with a partially filled receipt ring, including after reopen", () => {
    const f = fixture(), cipher = new DevVaultCipher({ key: () => f.key });
    const dotenv = (start: number, count: number) => Array.from({ length: count }, (_, i) => `FAKE_${start + i}=${"x".repeat(8000)}`).join("\n");
    // Create real records, then expand the encrypted fixture in bulk instead of
    // repeatedly encrypting and writing megabytes just to prepare the boundary.
    f.execute({ operation: "update", ...f.imported, dotenv: dotenv(0, 4) });
    f.execute({ operation: "update", ...f.imported, revision: 2, dotenv: dotenv(4, 2) });
    const profile = { ...f.imported, revision: 3 };
    type Seed = { profiles: { id: string; revision: number; payload: string }[];
      receipts: { command: { operationId: string } }[]; audit: Record<string, unknown>[] };
    const snapshotBefore = f.store.devVault.load(f.project.id)!;
    const seed = cipher.open<Seed>(snapshotBefore.ciphertext, f.project.id, "state", snapshotBefore.version);
    const template = seed.profiles[0];
    const environment = cipher.open(template.payload, f.project.id, template.id, template.revision);
    for (let i = 1; i < 16; i++) {
      const id = randomUUID();
      seed.profiles.push({ ...template, id, payload: cipher.seal(environment, f.project.id, id, template.revision) });
      seed.audit.push({ operation: "import", actorId: f.owner.principalId, at: f.now },
        ...Array.from({ length: 2 }, () => ({ operation: "update", actorId: f.owner.principalId, at: f.now, profileId: id })));
    }
    expect(f.store.devVault.commit(f.project.id, snapshotBefore.version, cipher.seal(seed, f.project.id, "state", snapshotBefore.version + 1))).toBe(true);
    for (let i = 0; i < 3; i++) f.approve(f.request("write", { ...profile, dotenv: dotenv(0, 4), source: "inline-dotenv" }), "until-revoked");
    const grant = f.approve(f.request("read", profile), "until-revoked");
    f.advance(2 * 86_400_000);
    const read = f.command({ operation: "read", ...profile, grantId: grant.id });
    f.execute(read, f.first.actor);
    const readSnapshot = f.store.devVault.load(f.project.id)!;
    const reads = cipher.open<Seed>(readSnapshot.ciphertext, f.project.id, "state", readSnapshot.version);
    const receipt = reads.receipts[0];
    reads.receipts = [...Array.from({ length: 61 }, () => ({ ...receipt, command: { ...receipt.command, operationId: randomUUID() } })), receipt];
    reads.audit.push(...Array.from({ length: 61 }, () => ({ ...reads.audit.at(-1)! })));
    expect(f.store.devVault.commit(f.project.id, readSnapshot.version, cipher.seal(reads, f.project.id, "state", readSnapshot.version + 1))).toBe(true);
    const padding = (bytes: number) => Array.from({ length: 4 }, (_, i) => `PAD_${i}=${"x".repeat(Math.max(0, Math.min(8192, bytes - i * 8192)))}`).join("\n");
    const pending = f.command({ operation: "request", ...profile, permission: "write", source: "inline-dotenv", dotenv: padding(0) });
    // Measure fixed overhead in a disposable candidate, without changing SQLite.
    let candidateBytes = 0;
    const probe = new DevVaultService({
      projectExists: id => f.store.devVault.projectExists(id), load: id => f.store.devVault.load(id),
      commit: (id, version, ciphertext) => {
        candidateBytes = Buffer.byteLength(canonicalJson(cipher.open(ciphertext, id, "state", version + 1))); return true;
      },
    }, { key: () => f.key }, f.identity, f.verifier, () => f.now);
    probe.execute({ command: pending }, f.first.actor);
    const bytes = Math.floor((DEV_VAULT_STATE_BYTES - candidateBytes) / 2);
    expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThan(32_000);
    f.execute({ ...pending, dotenv: padding(bytes) }, f.first.actor);
    const snapshot = f.store.devVault.load(f.project.id)!;
    const state = cipher.open<{ receipts: unknown[] }>(snapshot.ciphertext, f.project.id, "state", snapshot.version);
    expect(state.receipts).toHaveLength(63);
    expect(DEV_VAULT_STATE_BYTES - Buffer.byteLength(canonicalJson(state))).toBeLessThanOrEqual(1);
    expect(f.execute(read, f.first.actor)).toHaveProperty("environment");
    const revoke = f.command({ operation: "revoke", grantId: grant.id });
    const commit = vi.spyOn(f.store.devVault, "commit").mockReturnValueOnce(false);
    expect(() => f.execute(revoke)).toThrow("vault_conflict");
    commit.mockRestore();
    expect(f.execute(read, f.first.actor)).toHaveProperty("environment");
    const result = f.execute(revoke);
    expect(result).toMatchObject({ grantId: grant.id, revokedAt: f.now });
    f.reopen();
    const after = f.store.devVault.load(f.project.id)!;
    const retained = cipher.open<{ receipts: unknown[] }>(after.ciphertext, f.project.id, "state", after.version);
    expect(Buffer.byteLength(canonicalJson(retained))).toBeLessThanOrEqual(DEV_VAULT_STATE_BYTES);
    expect(retained.receipts).toHaveLength(63); // One old receipt made room for the revocation.
    expect(f.execute(revoke)).toEqual(result);
    expect(() => f.execute(read, f.first.actor)).toThrow("vault_denied");
    expect(() => f.execute({ ...read, operationId: randomUUID() }, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ operation: "requests" })).toMatchObject({ grants: expect.arrayContaining([expect.objectContaining({ lifetime: "until-revoked" })]) });
    expect(f.execute({ operation: "audit" })).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ operation: "revoke", grantId: grant.id })]) });
  });
  it("expires pending requests, handles rejection, and bounds an agent's pending queue", () => {
    const f = fixture(), r = f.request("read");
    f.execute({ operation: "reject", requestId: r.id });
    expect(() => f.approve(r)).toThrow("vault_denied");
    const expired = f.request("read"); f.advance(15 * 60_000); f.reopen();
    expect(() => f.approve(expired)).toThrow("vault_denied");
    for (let n = 0; n < 8; n++) f.request("read");
    expect(() => f.request("read")).toThrow("vault_limit");
  });
  it("fails closed on missing/wrong key and ciphertext project substitution", () => {
    const f = fixture(), cmd = f.command({ operation: "list" });
    for (const provider of [{ key: () => randomBytes(32) }, { key: (): Buffer => { throw new Error(FAKE_DOTENV); } }]) {
      const vault = new DevVaultService(f.store.devVault, provider, f.identity, f.verifier, () => f.now);
      expect(() => vault.execute({ command: cmd, proof: f.proof(cmd) }, f.owner)).toThrow("vault_unavailable");
    }
    const copy = f.store.devVault.load(f.project.id)!;
    expect(f.store.devVault.commit(f.otherProject.id, 0, copy.ciphertext)).toBe(true);
    expect(() => f.execute({ operation: "list", projectId: f.otherProject.id })).toThrow("vault_unavailable");
  });
  it("rejects staging/production classifications without changing tooling NODE_ENV", () => {
    const f = fixture();
    for (const environment of ["production", "staging", "prod"]) expect(() => f.execute({ operation: "import", dotenv: FAKE_DOTENV, environment })).toThrow("vault_invalid_request");
  });
  it("denies all pre-restore grants and plaintext receipts while retaining encrypted profiles", () => {
    const f = fixture(), grant = f.approve(f.request("read"), "until-revoked");
    const cmd = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    f.execute(cmd, f.first.actor); f.advance(1000); f.restoreFence(); f.reopen(); f.advance(1);
    expect(() => f.execute(cmd, f.first.actor)).toThrow("vault_denied");
    expect(f.execute({ operation: "read", ...f.imported })).toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
  });
  it.each(["2026-10-27T12:00:00Z", "2026-10-27T12:00:00.1Z", "2026-10-27T12:00:00.5Z", "2026-10-27T12:00:00.5000Z"])("denies owner proofs at or before the restore instant regardless of precision (%#)", issuedAt => {
    const f = fixture(), cmd = f.command({ operation: "read", ...f.imported });
    f.advance(500); f.restoreFence(); f.advance(100); f.reopen();
    expect(() => f.vault.execute({ command: cmd, proof: f.proof(cmd, f.owner, issuedAt) }, f.owner)).toThrow("vault_denied");
    expect(f.vault.execute({ command: cmd, proof: f.proof(cmd, f.owner, "2026-10-27T12:00:00.6Z") }, f.owner).result)
      .toMatchObject({ environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } });
  });
  it("preserves existing plaintext literal profile shapes and values without importing them", () => {
    const f = fixture();
    f.store.saveProjectEnvironmentProfile(f.project.id, { name: "literal-fixture", environment: { LITERAL_TEST_FLAG: "fake-literal" } }, "fixture");
    const before = f.store.getProject(f.project.id)!;
    f.execute({ operation: "update", ...f.imported, dotenv: "X=fake" });
    f.reopen();
    const after = f.store.getProject(f.project.id)!;
    expect(after.environmentProfiles).toEqual(before.environmentProfiles);
    expect(after.testEnvironmentProfiles).toEqual(before.testEnvironmentProfiles);
    expect(JSON.stringify(after)).not.toContain("FAKE_DEV_KEY_NAME");
  });
  it("checks exact use binding and keeps production delivery unavailable without consuming a grant", () => {
    const f = fixture();
    const binding = { commit: "a".repeat(40), commandDigest: "b".repeat(64), presetId: "node:test", workerId: randomUUID() };
    const grant = f.approve(f.request("use", { binding }));
    const cmd = f.command({ operation: "use", ...f.imported, grantId: grant.id, binding });
    expect(() => f.execute(cmd, f.first.actor)).toThrow("vault_use_unavailable");
    for (const changed of [{ commit: "c".repeat(40) }, { commandDigest: "c".repeat(64) }, { presetId: "node:build" }, { workerId: randomUUID() }]) {
      expect(() => f.execute({ ...cmd, binding: { ...binding, ...changed } }, f.first.actor)).toThrow("vault_denied");
    }
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: grant.id }, f.first.actor)).toThrow("vault_denied");
    expect(canonicalJson(f.execute({ operation: "requests" }, f.first.actor))).toContain('"consumedBy":null');
    expect(() => f.execute({ ...cmd, revision: 2 }, f.first.actor)).toThrow("vault_denied");
  });
});
