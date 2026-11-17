import { createDecipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevVaultCommand } from "@/shared/contracts/dev-vault";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup } from "../../controller-backup";
import { IdentityService } from "../../modules/identity";
import { KnowledgeService } from "../../modules/knowledge";
import { canonicalJson, DevVaultCipher, DevVaultService, devOwnerSigningMessage, Ed25519DevVaultOwnerVerifier } from "../../modules/dev-vault";
import { ExternalFileDevVaultKeyProvider } from "../dev-vault";
import { SqliteStateStore } from "./sqlite-state-store";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup } from "./upgrade-maintenance";
import { exact } from "./fixtures/exact-rows";
import { openStoreAt49 } from "./fixtures/released-schema";

/**
 * Gate rows 10 and 11 of slice 3, on real Vault ciphertext.
 *
 * Row 10: IDs, provenance, history ordinals, Vault bytes and the inputs of the
 * AAD are unchanged by the upgrade. Row 11: with the Vault key missing, the
 * upgrade still succeeds (plan section 2, S9: no Vault ciphertext is read or
 * rewritten).
 *
 * What the Vault is, in this product (`modules/dev-vault/crypto.ts`): one row
 * per registration in `dev_environment_vaults(project_id, version, ciphertext)`,
 * where `project_id` is the REGISTRATION's ID (`projects.id`), never a
 * Knowledge project's. The row's ciphertext is AES-256-GCM over the Vault state,
 * and each profile's payload inside that state is sealed again. Every seal
 * binds the AAD `canonicalJson(["wtc-dev-vault-v1", registrationId, label,
 * revision])`: the label is the literal "state" and the row's `version` for the
 * state, the profile's ID and its `revision` for a payload. So the AAD inputs
 * are the registration ID, the profile IDs, the revisions and the row version.
 * A mapping decision that gives a registration a parent project is the case in
 * which they could move (if code began to use the parent's ID, or if an ID were
 * rewritten), so the tests below run one.
 *
 * How the key is supplied (`bootstrap/dev-vault.ts`, `infrastructure/dev-vault`):
 * the environment variable WORKTREE_CONTROL_DEV_VAULT_KEY_FILE names an
 * absolute path of a private regular file of exactly 32 bytes outside the data
 * directory and any Git tree; `ExternalFileDevVaultKeyProvider` reads it on
 * every use and never creates or discovers one. "Missing" therefore means: the
 * variable is unset, or names a file that does not exist. The tests withhold the
 * key in both ways for the whole upgrade (the file is deleted before `inspect`
 * and written back only after `apply`), and show first that the stored
 * ciphertext is unreadable without it.
 *
 * Fixtures are synthetic: a new schema-49 database and its own key, data,
 * witness and backup paths in temporary directories.
 */
const TARGET = 52;
const KEY_ENV = "WORKTREE_CONTROL_DEV_VAULT_KEY_FILE";
const AAD_DOMAIN = "wtc-dev-vault-v1";
/** Historical clock of every fixture write that takes one. */
const PAST = "2025-03-01T10:00:00.000Z";
const roots: string[] = [];
const environmentBefore = process.env[KEY_ENV];
beforeEach(() => { delete process.env[KEY_ENV]; });
afterEach(() => {
  if (environmentBefore === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = environmentBefore;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporary = (prefix = "vault-upgrade-") => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
let ports = 5900;

const read = <T,>(paths: AppPaths, operation: (database: Database.Database) => T) => {
  const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
  try { return operation(database); } finally { database.close(); }
};
const backups = (paths: AppPaths): UpgradeBackup => async source => {
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory, schemaCeiling: TARGET }) };
};

// ---------------------------------------------------------------------------
// The Vault, as stored and as opened

interface VaultRow { project_id: string; version: number; ciphertext: string }
interface OpenedProfile { id: string; revision: number; environment: Record<string, string> }
interface OpenedVault { registration: string; version: number; profiles: OpenedProfile[] }
type Open = (ciphertext: string, registration: string, label: string, revision: number) => unknown;

const vaultRows = (paths: AppPaths) => read(paths, database => database.prepare("SELECT project_id,version,ciphertext FROM dev_environment_vaults ORDER BY project_id").all() as VaultRow[]);
const byRegistration = (vaults: OpenedVault[]) => [...vaults].sort((a, b) => a.registration < b.registration ? -1 : 1);

/** The AAD exactly as `DevVaultCipher` builds it, written out here so that its composition is pinned by the tests. */
const aad = (registration: string, label: string, revision: number) => Buffer.from(canonicalJson([AAD_DOMAIN, registration, label, revision]));
/** `DevVaultCipher.open` itself. */
const openWithCipher = (cipher: DevVaultCipher): Open => (ciphertext, registration, label, revision) => cipher.open(ciphertext, registration, label, revision);
/** AES-256-GCM by hand, with the layout `seal` writes (12-byte nonce, 16-byte tag, data): independent of `DevVaultCipher.open`. */
const openByHand = (key: Buffer): Open => (ciphertext, registration, label, revision) => {
  const data = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(aad(registration, label, revision));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
};
/** Opens every stored Vault row: the state under (registration, "state", version), then each profile under (registration, profile ID, revision). */
function openAll(rows: VaultRow[], open: Open): OpenedVault[] {
  return rows.map(row => {
    const state = open(row.ciphertext, row.project_id, "state", row.version) as { profiles: Array<{ id: string; revision: number; payload: string }> };
    return { registration: row.project_id, version: row.version, profiles: state.profiles.map(profile => ({
      id: profile.id, revision: profile.revision, environment: open(profile.payload, row.project_id, profile.id, profile.revision) as Record<string, string>,
    })) };
  });
}
/** Every AAD input list the Vault's rows are bound to, in stored order. */
const aadInputs = (vaults: OpenedVault[]) => vaults.flatMap(vault => [aad(vault.registration, "state", vault.version), ...vault.profiles.map(profile => aad(vault.registration, profile.id, profile.revision))].map(bytes => bytes.toString("utf8")));

// ---------------------------------------------------------------------------
// The schema-49 installation

interface Installation {
  paths: AppPaths; key: Buffer; keyFile: string; keyRoot: string;
  alpha: string; beta: string; knowledge: string;
  /** What the Vault holds, as written: the registrations in ID order. */
  expected: OpenedVault[];
}
/**
 * A schema-49 installation whose Vault was written by the product's own
 * `DevVaultService` (owner proof included) with a real key read from a key file
 * by `ExternalFileDevVaultKeyProvider`: registration `alpha` with two profiles
 * (one updated to revision 2, so the state is at version 3), registration `beta`
 * with one. A Knowledge project is linked to `alpha`, so that a decision can
 * accept that link as parenthood. The store is closed when this returns; the
 * key file is still in place.
 */
function installation(): Installation {
  const paths = resolveAppPaths(join(temporary(), "data"));
  const keyRoot = temporary("vault-key-"), keyFile = join(keyRoot, "vault.key"), key = randomBytes(32);
  writeFileSync(keyFile, key, { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const store = openStoreAt49(paths.databasePath);
  try {
    const identity = new IdentityService(store, () => PAST);
    const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
    const knowledgeService = new KnowledgeService(store, identity, () => PAST);
    const register = (name: string) => store.addProject({ name, repositoryPath: `/code/${name}`, port: ports++, executable: "node", args: [] }).id;
    const alpha = register("alpha"), beta = register("beta");
    const project = identity.createKnowledgeProject({ name: "Alpha knowledge" }, owner);
    identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }, owner);
    knowledgeService.setRuntimeLink(project.id, alpha, store.getKnowledgeProject(project.id)!.revision, { idempotencyKey: randomUUID() }, owner);
    knowledgeService.createTask(project.id, { title: "Fixture task", description: "Fixture body" }, { idempotencyKey: randomUUID() }, owner);

    const pair = generateKeyPairSync("ed25519");
    const vault = new DevVaultService(store.devVault, new ExternalFileDevVaultKeyProvider(keyFile, [paths.dataDirectory]), identity,
      new Ed25519DevVaultOwnerVerifier(() => pair.publicKey), () => PAST);
    const run = (registration: string, input: Record<string, unknown>) => {
      const command = { projectId: registration, operationId: randomUUID(), environment: "DEV", ...input } as DevVaultCommand;
      const proof = { issuedAt: PAST, signature: sign(null, devOwnerSigningMessage(command, owner, PAST), pair.privateKey).toString("base64") };
      return vault.execute({ command, proof }, owner).result as { profileId: string; revision: number };
    };
    const first = run(alpha, { operation: "import", dotenv: "FAKE_ALPHA_ONE=fake-alpha-value-1\nFAKE_ALPHA_SHARED=fake-shared-1" });
    const updated = run(alpha, { operation: "update", profileId: first.profileId, revision: first.revision, dotenv: "FAKE_ALPHA_SHARED=fake-shared-2\nFAKE_ALPHA_ADDED=fake-added" });
    const second = run(alpha, { operation: "import", dotenv: "FAKE_ALPHA_TWO=fake-alpha-value-2" });
    const other = run(beta, { operation: "import", dotenv: "FAKE_BETA_ONE=fake-beta-value-1" });
    expect(updated).toMatchObject({ profileId: first.profileId, revision: 2 });
    const expected = byRegistration([
      { registration: alpha, version: 3, profiles: [
        { id: first.profileId, revision: 2, environment: { FAKE_ALPHA_ADDED: "fake-added", FAKE_ALPHA_ONE: "fake-alpha-value-1", FAKE_ALPHA_SHARED: "fake-shared-2" } },
        { id: second.profileId, revision: 1, environment: { FAKE_ALPHA_TWO: "fake-alpha-value-2" } },
      ] },
      { registration: beta, version: 1, profiles: [{ id: other.profileId, revision: 1, environment: { FAKE_BETA_ONE: "fake-beta-value-1" } }] },
    ]);
    return { paths, key, keyFile, keyRoot, alpha, beta, knowledge: project.id, expected };
  } finally { store.close(); }
}

/** The upgrade, inspect then apply, with the decisions; returns its plan's attach acts. */
async function upgrade(paths: AppPaths, decisions?: unknown) {
  const inspection = inspectSqliteUpgrade(paths, TARGET, decisions);
  expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 49 });
  expect(await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backups(paths), TARGET)).toMatchObject({ state: "current", schemaVersion: 52 });
  return inspection.plan!.acts.filter(act => act.kind === "attach_registration").map(act => act.payload as { registrationId: string; projectId: string; basis: string });
}
const parents = (paths: AppPaths) => read(paths, database => Object.fromEntries((database.prepare("SELECT id,parent_project_id AS parent FROM projects").all() as Array<{ id: string; parent: string | null }>)
  .map(row => [row.id, row.parent])));
/** The tables whose rows carry the IDs, provenance and history of the installation. */
const IDENTITY_TABLES = ["dev_environment_vaults", "projects", "knowledge_projects", "knowledge_project_runtime_links", "knowledge_history", "knowledge_tasks"] as const;

describe("the Vault across the upgrade from schema 49 to 52", () => {
  it("keeps IDs, provenance, history, the Vault's bytes and the inputs of its AAD, and the same key still decrypts every entry", async () => {
    const { paths, key, keyFile, alpha, beta, knowledge, expected } = installation();
    const before = { rows: vaultRows(paths), exact: read(paths, exact) };

    // Preconditions: the rows are real ciphertext of the product's own Vault, not placeholders.
    expect(before.rows.map(row => [row.project_id, row.version])).toEqual(byRegistration(expected).map(vault => [vault.registration, vault.version]));
    expect(expected.find(vault => vault.registration === alpha)!.version).toBe(3);
    for (const row of before.rows) {
      const bytes = Buffer.from(row.ciphertext, "base64");
      expect(bytes.toString("base64")).toBe(row.ciphertext);
      expect(bytes.length).toBeGreaterThan(28);
      expect(bytes.includes(Buffer.from("fake-"))).toBe(false);
    }
    const cipher = new DevVaultCipher(new ExternalFileDevVaultKeyProvider(keyFile, [paths.dataDirectory]));
    expect(openAll(before.rows, openWithCipher(cipher))).toEqual(expected);
    expect(openAll(before.rows, openByHand(key))).toEqual(expected);

    // The upgrade, with a decision that gives `alpha` a parent project: the accepted link. `beta` gets a project created for it.
    const attached = await upgrade(paths, { links: [{ registrationId: alpha, projectId: knowledge }] });
    expect(attached).toHaveLength(2);
    expect(attached.find(act => act.registrationId === alpha)).toEqual({ registrationId: alpha, projectId: knowledge, basis: "accepted_link" });
    expect(attached.find(act => act.registrationId === beta)).toMatchObject({ registrationId: beta, basis: "created_project" });
    const created = attached.find(act => act.registrationId === beta)!.projectId;
    expect(parents(paths)).toEqual({ [alpha]: knowledge, [beta]: created });
    // Neither parent is a registration ID: a ProjectId is never a RegistrationId (S3), which is what the AAD relies on.
    expect(new Set([alpha, beta, knowledge, created]).size).toBe(4);

    // IDs, provenance and history ordinals: every row that existed is unchanged (the registration's table gains only its mapping columns).
    const after = read(paths, exact);
    for (const table of IDENTITY_TABLES) {
      expect(Object.keys(before.exact[table]).length, `${table} had rows`).toBeGreaterThan(0);
      for (const [rowid, row] of Object.entries(before.exact[table])) {
        expect(after[table][rowid], `${table} ${rowid} still exists`).toBeDefined();
        expect(Object.fromEntries(Object.entries(after[table][rowid]).filter(([column]) => column in row)), `${table} ${rowid}`).toEqual(row);
      }
    }
    // The Vault: the same rows, byte for byte, and no other row.
    const rows = vaultRows(paths);
    expect(rows).toEqual(before.rows);
    expect(after.dev_environment_vaults).toEqual(before.exact.dev_environment_vaults);

    // The same key decrypts every entry to the original plaintext, through the product's decryption and through an independent one.
    expect(openAll(rows, openWithCipher(cipher))).toEqual(expected);
    expect(openAll(rows, openByHand(key))).toEqual(expected);

    // The AAD inputs, explicitly: every one is read from the upgraded database and equals the one the entry was written under.
    const opened = openAll(rows, openWithCipher(cipher));
    expect(aadInputs(opened)).toEqual(aadInputs(expected));
    const registrations = read(paths, database => database.prepare("SELECT id FROM projects").pluck().all() as string[]);
    for (const vault of opened) {
      expect(registrations, "the AAD's project input is a registration").toContain(vault.registration);
      expect([alpha, beta]).toContain(vault.registration);
    }
    const state = opened.find(vault => vault.registration === alpha)!;
    expect(aad(alpha, "state", 3).toString("utf8")).toBe(JSON.stringify([AAD_DOMAIN, alpha, "state", 3]));
    expect(aad(alpha, state.profiles[0].id, 2).toString("utf8")).toBe(JSON.stringify([AAD_DOMAIN, alpha, state.profiles[0].id, 2]));

    // Control: an AAD input that is not the stored one fails, on the upgraded rows. If the Vault stopped checking the AAD, or
    // if the upgrade had moved a registration under its parent project, one of these would succeed or the decryptions above would fail.
    const row = (registration: string) => rows.find(candidate => candidate.project_id === registration)!;
    const profile = (registration: string) => opened.find(vault => vault.registration === registration)!.profiles[0];
    for (const [registration, parent] of [[alpha, knowledge], [beta, created]] as const) {
      const { ciphertext, version } = row(registration), { id, revision } = profile(registration);
      expect(() => cipher.open(ciphertext, parent, "state", version), `${registration}: the parent project instead of the registration`).toThrow("vault_unavailable");
      expect(() => cipher.open(ciphertext, registration, "state", version + 1), `${registration}: another row version`).toThrow("vault_unavailable");
      expect(() => cipher.open(ciphertext, registration, id, version), `${registration}: a profile label for the state`).toThrow("vault_unavailable");
      expect(() => openByHand(key)(ciphertext, parent, "state", version), `${registration}: by hand, the parent project`).toThrow();
      expect(() => openByHand(key)(ciphertext, registration, "state", version + 1), `${registration}: by hand, another version`).toThrow();
      const sealed = (cipher.open<{ profiles: Array<{ payload: string }> }>(ciphertext, registration, "state", version)).profiles[0].payload;
      expect(() => cipher.open(sealed, parent, id, revision), `${registration}: a profile under the parent project`).toThrow("vault_unavailable");
      expect(() => cipher.open(sealed, registration, id, revision + 1), `${registration}: a profile at another revision`).toThrow("vault_unavailable");
      expect(() => cipher.open(sealed, registration, "other-profile", revision), `${registration}: a profile under another ID`).toThrow("vault_unavailable");
    }
    expect(() => new DevVaultCipher({ key: () => randomBytes(32) }).open(row(alpha).ciphertext, alpha, "state", 3), "another key").toThrow("vault_unavailable");
  }, 30_000);

  it.each([
    ["the key variable is unset", (keyRoot: string) => { rmSync(keyRoot, { recursive: true, force: true }); delete process.env[KEY_ENV]; }],
    ["the key variable names a file that does not exist", (keyRoot: string) => { rmSync(keyRoot, { recursive: true, force: true }); process.env[KEY_ENV] = join(keyRoot, "vault.key"); }],
  ])("upgrades, and leaves the Vault's ciphertext byte for byte, while the key is missing: %s", async (_name, withhold) => {
    const { paths, key, keyRoot, alpha, knowledge, expected } = installation();
    const before = { rows: vaultRows(paths), exact: read(paths, exact) };
    expect(before.rows).toHaveLength(2);

    // 1. Withhold the key, as this product supplies it, for the whole upgrade.
    withhold(keyRoot);
    const missing = () => new ExternalFileDevVaultKeyProvider(process.env[KEY_ENV], [paths.dataDirectory]);
    expect(() => missing().key()).toThrow("vault_unavailable");
    // The ciphertext is real: without the key nothing opens it, through the product's own cipher on its own provider.
    const withoutKey = new DevVaultCipher(missing());
    for (const row of before.rows) expect(() => withoutKey.open(row.ciphertext, row.project_id, "state", row.version)).toThrow("vault_unavailable");

    // 2. Inspect and apply succeed, including a decision that gives a registration a parent project.
    const attached = await upgrade(paths, { links: [{ registrationId: alpha, projectId: knowledge }] });
    expect(attached.map(act => act.basis).sort()).toEqual(["accepted_link", "created_project"]);
    expect(() => missing().key(), "the key was still missing after the upgrade").toThrow("vault_unavailable");

    // 3. The ciphertext rows are byte-identical, as read raw and through the ordinary store's own Vault reader at 52.
    const rows = vaultRows(paths);
    expect(rows).toEqual(before.rows);
    expect(read(paths, exact).dev_environment_vaults).toEqual(before.exact.dev_environment_vaults);
    const store = new SqliteStateStore(paths.databasePath);
    try {
      expect(store.schemaVersion()).toBe(52);
      for (const row of before.rows) expect(store.devVault.load(row.project_id)).toEqual({ version: row.version, ciphertext: row.ciphertext });
    } finally { store.close(); }

    // 4. Supply the key again, in the way the product reads it (the variable names a private file of 32 bytes): the content decrypts.
    const restoredRoot = temporary("vault-key-restored-"), restoredFile = join(restoredRoot, "vault.key");
    writeFileSync(restoredFile, key, { mode: 0o600 }); chmodSync(restoredFile, 0o600);
    process.env[KEY_ENV] = restoredFile;
    expect(readFileSync(restoredFile)).toEqual(key);
    const restored = new DevVaultCipher(new ExternalFileDevVaultKeyProvider(process.env[KEY_ENV], [paths.dataDirectory]));
    expect(openAll(rows, openWithCipher(restored))).toEqual(expected);
    // Control: a different key in the same place does not.
    const other = new DevVaultCipher({ key: () => randomBytes(32) });
    for (const row of rows) expect(() => other.open(row.ciphertext, row.project_id, "state", row.version)).toThrow("vault_unavailable");
  }, 30_000);
});
