import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { schemaTarget } from "./migration-registry";
import { MAPPING_CLOCK_MAX, PROJECT_MAPPING_VERSION } from "./mapping-structure-migration";
import {
  compareText, escapeDisplay, FindingList, sampled, UPGRADE_FINDINGS_LIMIT, UPGRADE_PLAN_LIMITS, UpgradeError,
  type UpgradeAct, type UpgradeActContext, type UpgradeActDomain, type UpgradeActKind, type UpgradeProposalContext,
} from "./upgrade-contract";
import { unreadableTexts, type TextColumns } from "./stored-text";

/**
 * The project-mapping acts of the explicit offline upgrade (integration branch,
 * provisional, not registered anywhere outside the upgrade): one proposal pass
 * that decides, from the database and the operator's decisions, which project
 * every registration (`projects`) and every remote identity
 * (`remote_project_identities`) belongs to, and three act kinds that carry
 * those decisions out inside the upgrade's schema transaction. The rules are
 * in `docs/architecture.md` ("Project mapping acts").
 *
 * Nothing is inferred: never from a name, a repository path or a remote URL.
 * A link row (`knowledge_project_runtime_links`) or a worker binding
 * (`remote_worker_project_grants`) becomes parenthood only when the operator
 * accepts it; the journal only nominates, and the plan hash is the approval.
 * The pass reads no Vault ciphertext, no repository path, no remote URL, no
 * environment value and no stored JSON into the plan: the review carries IDs,
 * counts, statuses, timestamps and escaped display names only. Every stored
 * value it reads is first checked for its storage class
 * ({@link MAPPING_STORED_COLUMNS}), and every identifier it compares or an act
 * writes back or matches on for reading back exactly
 * ({@link MAPPING_TEXT_COLUMNS}).
 */

/** The ID rule of the journal's `subject_id` and `project_id` (see mapping-structure-migration.ts). */
function journalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && Buffer.byteLength(value, "utf8") <= 640 && [...value].length <= 160;
}
const idSchema = z.string().refine(journalId);
/** Any stored ID as text, as the review shows it (bounded by the plan's byte limit). */
const storedIdSchema = z.string().min(1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The name rule of a Knowledge project, the stricter of the application's
 * creation path (`IdentityService.createKnowledgeProject`: trimmed, 1 to 120)
 * and the export/import snapshot schema (`project-transfer-schema.ts`: 1 to
 * 120). Both count JavaScript string length (UTF-16 code units).
 */
export const PROJECT_NAME_LIMIT = 120;
/** True when `value` is a name the application itself could have created and the snapshot schema accepts. */
export function applicationProjectName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= PROJECT_NAME_LIMIT && value.trim() === value;
}
const nameSchema = z.string().refine(applicationProjectName);
/** How a new project's name came from its subject's name. */
export type ProjectNaming = "copied" | "trimmed" | "shortened" | "replaced";
/** At most {@link PROJECT_NAME_LIMIT} code units, never splitting a surrogate pair, then trimmed at the end again. */
function cutName(text: string): string {
  if (text.length <= PROJECT_NAME_LIMIT) return text;
  let end = PROJECT_NAME_LIMIT;
  const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end).trimEnd();
}
/**
 * The display name of the project created for a subject, deterministic and
 * always within {@link applicationProjectName}: the subject's name trimmed
 * (`String.prototype.trim`, as the application trims); if longer than the
 * limit, cut at it without splitting a surrogate pair and trimmed at the end
 * again; if empty after trimming, `Registration <id>` or `Remote identity
 * <id>`, bounded the same way. It is display text only and decides nothing.
 */
export function deriveProjectName(kind: "registration" | "remote_identity", id: string, source: string): { name: string; naming: ProjectNaming } {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { name: cutName(`${kind === "registration" ? "Registration" : "Remote identity"} ${id}`.trim()), naming: "replaced" };
  if (trimmed.length > PROJECT_NAME_LIMIT) return { name: cutName(trimmed), naming: "shortened" };
  return { name: trimmed, naming: trimmed === source ? "copied" : "trimmed" };
}
const LIST = UPGRADE_PLAN_LIMITS.acts;
/** The most journal rows, links and bindings the pass reads; more is refused, never truncated. */
export const MAPPING_READ_LIMIT = 500_000;

function gate(): void {
  try { schemaTarget(PROJECT_MAPPING_VERSION); } catch { throw new UpgradeError("upgrade_unsupported", "none"); }
}

// ---------------------------------------------------------------------------
// Decisions

const decisionInputSchema = z.object({
  links: z.array(z.object({ registrationId: idSchema, projectId: storedIdSchema.max(4096) }).strict()).max(LIST).optional(),
  bindings: z.array(z.object({ remoteIdentityId: idSchema, registrationId: idSchema }).strict()).max(LIST).optional(),
  isolate: z.object({ registrations: z.array(idSchema).max(LIST).optional(), remoteIdentities: z.array(idSchema).max(LIST).optional() }).strict().optional(),
}).strict();
export type MappingDecisionsInput = z.input<typeof decisionInputSchema>;
export interface MappingDecisions {
  links: Array<{ registrationId: string; projectId: string }>;
  bindings: Array<{ remoteIdentityId: string; registrationId: string }>;
  isolate: { registrations: string[]; remoteIdentities: string[] };
}
const linkKey = (entry: { registrationId: string; projectId: string }) => [entry.registrationId, entry.projectId] as const;
const bindingKey = (entry: { remoteIdentityId: string; registrationId: string }) => [entry.remoteIdentityId, entry.registrationId] as const;
const pairOrder = (a: readonly [string, string], b: readonly [string, string]) => compareText(a[0], b[0]) || compareText(a[1], b[1]);
const strictlySorted = <T,>(items: readonly T[], order: (a: T, b: T) => number) => items.every((item, index) => index === 0 || order(items[index - 1], item) < 0);
/** The stored form: every key present, every list sorted and without duplicates. */
const storedDecisionsSchema = z.object({
  links: z.array(z.object({ registrationId: idSchema, projectId: storedIdSchema.max(4096) }).strict()).max(LIST),
  bindings: z.array(z.object({ remoteIdentityId: idSchema, registrationId: idSchema }).strict()).max(LIST),
  isolate: z.object({ registrations: z.array(idSchema).max(LIST), remoteIdentities: z.array(idSchema).max(LIST) }).strict(),
}).strict().refine(value => strictlySorted(value.links.map(linkKey), pairOrder) && strictlySorted(value.bindings.map(bindingKey), pairOrder)
  && strictlySorted(value.isolate.registrations, compareText) && strictlySorted(value.isolate.remoteIdentities, compareText)) as unknown as z.ZodType<MappingDecisions>;

/**
 * Validates the operator's decisions strictly, without the database: unknown
 * keys, malformed or unbounded IDs, duplicates, a subject both accepted and
 * isolated, and a registration accepted into two projects are refused as
 * `upgrade_decisions_invalid`. Returns the normalised form (every key present,
 * lists sorted). Whether each entry names an existing row is checked by the
 * proposal pass.
 */
export function normaliseMappingDecisions(input: Record<string, unknown>): MappingDecisions {
  gate();
  const parsed = decisionInputSchema.safeParse(input);
  const findings = new FindingList();
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 100)) findings.add("decisions", issue.path.map(String).join(".") || "decisions", "malformed or out of bounds");
    findings.raise("upgrade_decisions_invalid");
    throw new UpgradeError("upgrade_decisions_invalid", "upgrade inspect");
  }
  const links = [...(parsed.data.links ?? [])].sort((a, b) => pairOrder(linkKey(a), linkKey(b)));
  const bindings = [...(parsed.data.bindings ?? [])].sort((a, b) => pairOrder(bindingKey(a), bindingKey(b)));
  const registrations = [...(parsed.data.isolate?.registrations ?? [])].sort(compareText);
  const remoteIdentities = [...(parsed.data.isolate?.remoteIdentities ?? [])].sort(compareText);
  const duplicates = <T,>(items: readonly T[], key: (item: T) => string, table: string, id: (item: T) => string) => {
    for (let index = 1; index < items.length; index++) if (key(items[index - 1]) === key(items[index])) findings.add(table, id(items[index]), "duplicate decision");
  };
  duplicates(links, entry => linkKey(entry).join("\u0000"), "decisions.links", entry => entry.registrationId);
  duplicates(bindings, entry => bindingKey(entry).join("\u0000"), "decisions.bindings", entry => entry.remoteIdentityId);
  duplicates(registrations, entry => entry, "decisions.isolate.registrations", entry => entry);
  duplicates(remoteIdentities, entry => entry, "decisions.isolate.remoteIdentities", entry => entry);
  const accepted = new Map<string, Set<string>>();
  for (const entry of links) accepted.set(entry.registrationId, (accepted.get(entry.registrationId) ?? new Set()).add(entry.projectId));
  for (const [registration, projects] of accepted) if (projects.size > 1) findings.add("decisions.links", registration, "registration accepted into more than one project");
  const isolatedRegistrations = new Set(registrations), isolatedIdentities = new Set(remoteIdentities);
  for (const registration of accepted.keys()) if (isolatedRegistrations.has(registration)) findings.add("decisions.links", registration, "registration both accepted and isolated");
  for (const identity of new Set(bindings.map(entry => entry.remoteIdentityId))) if (isolatedIdentities.has(identity)) findings.add("decisions.bindings", identity, "remote identity both accepted and isolated");
  findings.raise("upgrade_decisions_invalid");
  return { links, bindings, isolate: { registrations, remoteIdentities } };
}

// ---------------------------------------------------------------------------
// Acts

export type RegistrationBasis = "created_project" | "accepted_link" | "journal_reuse";
export type IdentityBasis = "created_project" | "accepted_binding" | "journal_reuse";
const createPayload = z.object({ projectId: z.string().regex(UUID), name: nameSchema }).strict();
const attachPayload = z.object({ registrationId: idSchema, projectId: idSchema, basis: z.enum(["created_project", "accepted_link", "journal_reuse"]) }).strict();
const mapPayload = z.object({ remoteIdentityId: idSchema, projectId: idSchema, basis: z.enum(["created_project", "accepted_binding", "journal_reuse"]) }).strict();
export type CreateProjectPayload = z.infer<typeof createPayload>;
export type AttachRegistrationPayload = z.infer<typeof attachPayload>;
export type MapRemoteIdentityPayload = z.infer<typeof mapPayload>;
export const CREATE_PROJECT = "create_project", ATTACH_REGISTRATION = "attach_registration", MAP_REMOTE_IDENTITY = "map_remote_identity";

/** A precondition of an act that does not hold: the transaction aborts. The message carries no value. */
function actFailed(kind: string): never { throw new Error(`Upgrade act ${kind} found the database other than its plan requires.`); }

/**
 * `create_project`: one `knowledge_projects` row in the form the application
 * writes one (`active`, revision 1, both timestamps the run's time, a name
 * within the application's rule, checked again here). It writes
 * no grant, role, membership, link, history row or audit event: a project row
 * alone is a valid, readable project, and the run's own audit event and the
 * journal rows of the acts that attach to it record why it exists.
 */
function createProject(database: Database.Database, payload: CreateProjectPayload, context: UpgradeActContext): void {
  gate();
  const id = payload.projectId;
  if (!UUID.test(id) || !applicationProjectName(payload.name)) actFailed(CREATE_PROJECT);
  if (database.prepare("SELECT 1 FROM knowledge_projects WHERE id=? UNION ALL SELECT 1 FROM projects WHERE id=? UNION ALL SELECT 1 FROM remote_project_identities WHERE id=? LIMIT 1").get(id, id, id)) actFailed(CREATE_PROJECT);
  if (database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,'active',1,?,?)").run(id, payload.name, context.at, context.at).changes !== 1) actFailed(CREATE_PROJECT);
}

const CLOCK = "(SELECT value FROM project_mapping_clock WHERE singleton=1)";
/**
 * Sets the parent of one parentless row and journals it. One clock advance,
 * then one UPDATE that step 51's triggers accept for an unstamped and a
 * stamped row alike: an unstamped row takes the new value as its incarnation
 * (issued, fresh and therefore held by no other row) and as its mapping
 * version; a stamped row keeps its incarnation and takes the new value as its
 * mapping version (larger than before, equal to the clock). At an exhausted
 * clock the advance fails the clock's CHECK and the transaction aborts.
 */
function attach(database: Database.Database, table: "projects" | "remote_project_identities", subject: "registration" | "remote_identity", kind: string,
  id: string, projectId: string, basis: string, context: UpgradeActContext): void {
  gate();
  const row = database.prepare(`SELECT parent_project_id AS parent FROM ${table} WHERE id=?`).get(id) as { parent: unknown } | undefined;
  if (!row || row.parent !== null) actFailed(kind);
  if (!database.prepare("SELECT 1 FROM knowledge_projects WHERE id=?").get(projectId)) actFailed(kind);
  if (database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run().changes !== 1) actFailed(kind);
  if (database.prepare(`UPDATE ${table} SET incarnation=CASE WHEN incarnation=0 THEN ${CLOCK} ELSE incarnation END,mapping_version=${CLOCK},parent_project_id=? WHERE id=? AND parent_project_id IS NULL`)
    .run(projectId, id).changes !== 1) actFailed(kind);
  const after = database.prepare(`SELECT parent_project_id AS parent,incarnation,mapping_version AS version,${CLOCK} AS clock FROM ${table} WHERE id=?`).get(id) as { parent: unknown; incarnation: unknown; version: unknown; clock: unknown };
  if (after.parent !== projectId || typeof after.incarnation !== "number" || after.incarnation < 1 || after.version !== after.clock) actFailed(kind);
  database.prepare("INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(subject, id, after.incarnation, projectId, basis, context.planHash, context.receipt, context.at);
}

const kinds: ReadonlyArray<UpgradeActKind> = Object.freeze([
  { kind: CREATE_PROJECT, payload: createPayload, execute: (database, payload, context) => createProject(database, payload as CreateProjectPayload, context) },
  { kind: ATTACH_REGISTRATION, payload: attachPayload, execute: (database, payload, context) => {
    const act = payload as AttachRegistrationPayload;
    attach(database, "projects", "registration", ATTACH_REGISTRATION, act.registrationId, act.projectId, act.basis, context);
  } },
  { kind: MAP_REMOTE_IDENTITY, payload: mapPayload, execute: (database, payload, context) => {
    const act = payload as MapRemoteIdentityPayload;
    attach(database, "remote_project_identities", "remote_identity", MAP_REMOTE_IDENTITY, act.remoteIdentityId, act.projectId, act.basis, context);
  } },
] as UpgradeActKind[]);

// ---------------------------------------------------------------------------
// Review

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const display = z.string().nullable();
const PRINCIPAL_KINDS = ["owner", "human", "agent", "worker", "installation"] as const;
type PrincipalKind = typeof PRINCIPAL_KINDS[number];
const rowCounts = z.object({ unrevoked: count, revoked: count }).strict();
const authorityCounts = z.object(Object.fromEntries(PRINCIPAL_KINDS.map(kind => [kind, rowCounts]))).strict() as unknown as z.ZodType<AuthorityRowCounts>;
/**
 * Stored authority rows by the kind of the principal they name, split by the
 * row's own revocation field (`revoked_at` NULL or not; a credential scope by
 * its credential's stored `status`, `active` or not). These are row counts,
 * not distinct principals and not effective access: a revoked principal, an
 * expired credential or a missing parent is not taken into account.
 */
export type AuthorityRowCounts = Record<PrincipalKind, { unrevoked: number; revoked: number }>;
const NOMINATION_REASONS = ["used", "isolated", "accepted_decision", "accepted_basis", "project_missing", "unstamped", "incarnation_changed", "provenance"] as const;
export type NominationReason = typeof NOMINATION_REASONS[number];
const nominationSchema = z.object({
  sequence: count, recordedAt: display, projectId: idSchema, basis: z.enum(["created_project", "accepted_link", "accepted_binding", "journal_reuse"]),
  incarnation: count, used: z.boolean(), reason: z.enum(NOMINATION_REASONS),
}).strict();
export type MappingNomination = z.infer<typeof nominationSchema>;
/**
 * A subject's destination. `created`: this subject's own `create_project` act
 * creates it. `existing`: it is a row of `knowledge_projects` now. A subject
 * that joins a project created in this plan for another subject (an accepted
 * binding to a registration that gets a new project) has both false.
 */
const registrationOutcome = z.object({ projectId: idSchema, basis: z.enum(["created_project", "accepted_link", "journal_reuse"]), created: z.boolean(), existing: z.boolean() }).strict();
const identityOutcome = z.object({ projectId: idSchema, basis: z.enum(["created_project", "accepted_binding", "journal_reuse"]), created: z.boolean(), existing: z.boolean() }).strict();
const registrationReview = z.object({
  id: idSchema, name: display, incarnation: count, outcome: registrationOutcome,
  link: z.object({
    projectId: storedIdSchema, linkedAt: display, accepted: z.boolean(),
    lastChange: z.object({ operation: display, principalId: display, principalKind: display, authenticationMethod: display, at: display }).strict().nullable(),
  }).strict().nullable(),
  nomination: nominationSchema.nullable(),
  inventory: z.object({ vaultRecords: count, reservations: count, activeReservations: count, testRuns: count, environmentProfiles: count.nullable() }).strict(),
}).strict();
const identityReview = z.object({
  id: idSchema, name: display, status: display, incarnation: count, outcome: identityOutcome,
  bindings: z.array(z.object({
    workerId: storedIdSchema, workerName: display, workerStatus: display, workerPrincipalStatus: display, registrationId: idSchema, revoked: z.boolean(), accepted: z.boolean(),
  }).strict()),
  nomination: nominationSchema.nullable(),
  inventory: z.object({ requests: count, attempts: count }).strict(),
}).strict();
const memberSchema = z.object({ id: storedIdSchema, plan: z.boolean(), journal: z.boolean(), present: z.boolean() }).strict();
const projectReview = z.object({
  id: idSchema, name: display, status: display,
  inventory: z.object({ threads: count, replies: count, tasks: count, memories: count, attachments: count, history: count, importBatches: count }).strict(),
  registrations: z.array(memberSchema), remoteIdentities: z.array(memberSchema),
  authorityRows: z.object({
    knowledgeGrants: authorityCounts, roleBindings: authorityCounts, runtimeDelegations: authorityCounts, runtimeMemberships: authorityCounts,
    credentialScopes: authorityCounts, workerBindings: authorityCounts, remotePrincipalGrants: authorityCounts,
  }).strict(),
}).strict();
const subjectKind = z.enum(["registration", "remote_identity"]);
/**
 * A project this plan creates: the name it gets (escaped for display), how
 * that name came from its subject's (`sourceLength` in UTF-16 code units), the
 * subject it is created for and every subject that joins it in this plan. It
 * has no Knowledge content and no stored authority: it does not exist yet.
 */
const newProjectReview = z.object({
  id: z.string().regex(UUID), name: z.string(), naming: z.enum(["copied", "trimmed", "shortened", "replaced"]), sourceLength: count,
  createdFor: z.object({ kind: subjectKind, id: idSchema }).strict(),
  registrations: z.array(idSchema), remoteIdentities: z.array(idSchema),
}).strict();
const reviewSchema = z.object({
  registrations: z.array(registrationReview), remoteIdentities: z.array(identityReview), projects: z.array(projectReview), newProjects: z.array(newProjectReview), untouchedProjects: count,
}).strict();
export type MappingReview = z.infer<typeof reviewSchema>;
export type RegistrationReview = z.infer<typeof registrationReview>;
export type RemoteIdentityReview = z.infer<typeof identityReview>;
export type ProjectReview = z.infer<typeof projectReview>;
export type NewProjectReview = z.infer<typeof newProjectReview>;

// ---------------------------------------------------------------------------
// Stored values

/** The storage class a column must hold: SQLite's `typeof()` of the value. */
export type StorageRule = "text" | "text_or_null" | "integer";
export interface StoredColumns {
  readonly table: string;
  /** The column that names an offending row in a finding. */
  readonly key: string;
  /** Only from step 51 on (the table or column does not exist before). */
  readonly mapped?: boolean;
  readonly columns: ReadonlyArray<readonly [column: string, rule: StorageRule, mapped?: boolean]>;
}
/**
 * Every column the proposal pass and its review read, with the storage class
 * it must hold. The tables are not STRICT, so a column's declared type does
 * not stop a BLOB, a REAL or a wrong class from being stored; any other class
 * is refused as `upgrade_mapping_malformed` before a value is used. Ranges and
 * shapes (bounded IDs, safe integers, known kinds and bases) are checked
 * afterwards by the pass itself.
 */
const STORED_COLUMNS: StoredColumns[] = [
  { table: "projects", key: "id", columns: [["id", "text"], ["name", "text"], ["environment_profiles_json", "text"],
    ["parent_project_id", "text_or_null", true], ["incarnation", "integer", true], ["mapping_version", "integer", true]] },
  { table: "remote_project_identities", key: "id", columns: [["id", "text"], ["name", "text"], ["status", "text"],
    ["parent_project_id", "text_or_null", true], ["incarnation", "integer", true], ["mapping_version", "integer", true]] },
  { table: "knowledge_projects", key: "id", columns: [["id", "text"], ["name", "text"], ["status", "text"]] },
  { table: "knowledge_project_runtime_links", key: "knowledge_project_id", columns: [["knowledge_project_id", "text"], ["runtime_project_id", "text_or_null"], ["linked_at", "text"], ["unlinked_at", "text_or_null"]] },
  { table: "remote_worker_project_grants", key: "project_id", columns: [["worker_id", "text"], ["project_id", "text"], ["local_project_id", "text"], ["revoked_at", "text_or_null"]] },
  { table: "remote_workers", key: "id", columns: [["id", "text"], ["principal_id", "text"], ["name", "text"], ["status", "text"]] },
  { table: "remote_principals", key: "id", columns: [["id", "text"], ["kind", "text"], ["status", "text"]] },
  { table: "project_mapping_clock", key: "singleton", mapped: true, columns: [["singleton", "integer"], ["value", "integer"]] },
  { table: "project_mapping_journal", key: "subject_id", mapped: true, columns: [["sequence", "integer"], ["subject_kind", "text"], ["subject_id", "text"], ["subject_incarnation", "integer"],
    ["project_id", "text"], ["basis", "text"], ["recorded_at", "text"]] },
  { table: "dev_environment_vaults", key: "project_id", columns: [["project_id", "text"]] },
  { table: "reservations", key: "id", columns: [["project_id", "text"], ["released_at", "text_or_null"]] },
  { table: "test_runs", key: "id", columns: [["project_id", "text"]] },
  { table: "remote_verification_requests", key: "id", columns: [["id", "text"], ["project_id", "text"]] },
  { table: "remote_verification_attempts", key: "id", columns: [["request_id", "text"]] },
  { table: "knowledge_history", key: "id", columns: [["project_id", "text"], ["record_kind", "text"], ["record_id", "text"], ["operation", "text"], ["principal_id", "text"],
    ["authentication_method", "text"], ["created_at", "text"]] },
  ...["knowledge_project_grants", "knowledge_role_bindings", "runtime_delegations", "runtime_human_memberships", "remote_principal_project_grants"]
    .map((table): StoredColumns => ({ table, key: "project_id", columns: [["project_id", "text"], ["principal_id", "text"], ["revoked_at", "text_or_null"]] })),
  { table: "runtime_credential_scopes", key: "project_id", columns: [["credential_id", "text"], ["project_id", "text"]] },
  { table: "principal_credentials", key: "id", columns: [["id", "text"], ["principal_id", "text"], ["status", "text"]] },
  ...["knowledge_threads", "knowledge_replies", "knowledge_tasks", "knowledge_memories", "knowledge_attachments"].map((table): StoredColumns => ({ table, key: "id", columns: [["project_id", "text"]] })),
  { table: "knowledge_import_batches", key: "id", columns: [["target_project_id", "text"]] },
];
export const MAPPING_STORED_COLUMNS: ReadonlyArray<StoredColumns> = Object.freeze(STORED_COLUMNS);
/** Text columns of {@link MAPPING_TEXT_COLUMNS}; `mapped` and `mappedColumns` only from step 51 on. */
export interface MappingTextColumns extends TextColumns { readonly mapped?: boolean; readonly mappedColumns?: readonly string[] }
/**
 * Every identifier the proposal pass compares in JavaScript (subjects, the
 * projects they may join, links, bindings, workers and the journal) or an act
 * writes back or matches on (`attach_registration` and `map_remote_identity`
 * match their subject by `WHERE id=?` and their project in
 * `knowledge_projects`; they and the journal write subject and project IDs),
 * on every row. Each must read back exactly (`stored-text.ts`): a stored ID
 * whose bytes are not the UTF-8 of the string read back would be planned, then
 * match no row or write other bytes inside the transaction. It is refused as
 * `upgrade_mapping_malformed` before a value is used. A decision is JavaScript
 * text and reaches an act only through equality with one of these IDs.
 */
export const MAPPING_TEXT_COLUMNS: ReadonlyArray<MappingTextColumns> = Object.freeze([
  { table: "projects", key: "id", columns: ["id", "parent_project_id"], mappedColumns: ["parent_project_id"] },
  { table: "remote_project_identities", key: "id", columns: ["id", "parent_project_id"], mappedColumns: ["parent_project_id"] },
  { table: "knowledge_projects", key: "id", columns: ["id"] },
  { table: "knowledge_project_runtime_links", key: "knowledge_project_id", columns: ["knowledge_project_id", "runtime_project_id"] },
  { table: "remote_worker_project_grants", key: "project_id", columns: ["worker_id", "project_id", "local_project_id"] },
  { table: "remote_workers", key: "id", columns: ["id"] },
  { table: "project_mapping_journal", key: "subject_id", mapped: true, columns: ["subject_id", "project_id"] },
]);
const RULE_TEXT: Readonly<Record<StorageRule, string>> = { text: "text", text_or_null: "text or null", integer: "integer" };
const holds = (type: unknown, rule: StorageRule) => rule === "text" ? type === "text" : rule === "integer" ? type === "integer" : type === "text" || type === "null";
const holdsSql = (column: string, rule: StorageRule) => rule === "text_or_null" ? `typeof("${column}") IN ('text','null')` : `typeof("${column}")='${rule}'`;

/** Adds a finding for every row of {@link MAPPING_TEXT_COLUMNS} whose identifier does not read back exactly (the first 100 per table listed, all counted). */
function texts(database: Database.Database, mapped: boolean, findings: FindingList): void {
  for (const entry of MAPPING_TEXT_COLUMNS) {
    if (entry.mapped && !mapped) continue;
    const columns = mapped ? entry.columns : entry.columns.filter(column => !entry.mappedColumns?.includes(column));
    const { rows, count } = unreadableTexts(database, { ...entry, columns }, UPGRADE_FINDINGS_LIMIT);
    for (const row of rows) findings.add(row.table, row.id, row.problem);
    if (count > rows.length) findings.more(count - rows.length);
  }
}

/** Adds a finding for every row of {@link MAPPING_STORED_COLUMNS} whose value is of another storage class (the first 100 per table read, all counted). */
function storageClasses(database: Database.Database, mapped: boolean, findings: FindingList): void {
  for (const entry of MAPPING_STORED_COLUMNS) {
    if (entry.mapped && !mapped) continue;
    const columns = entry.columns.filter(([, , onlyMapped]) => mapped || !onlyMapped);
    const where = `NOT (${columns.map(([column, rule]) => holdsSql(column, rule)).join(" AND ")})`;
    const name = `CASE typeof("${entry.key}") WHEN 'text' THEN "${entry.key}" WHEN 'integer' THEN CAST("${entry.key}" AS TEXT) ELSE '<' || typeof("${entry.key}") || '>' END`;
    const rows = database.prepare(`SELECT ${name},${columns.map(([column]) => `typeof("${column}")`).join(",")} FROM "${entry.table}" WHERE ${where} LIMIT ${UPGRADE_FINDINGS_LIMIT}`).raw().all() as unknown[][];
    for (const row of rows) {
      findings.add(entry.table, String(row[0]), columns.flatMap(([column, rule], index) => holds(row[index + 1], rule) ? [] : [`${column} is ${String(row[index + 1])}, expected ${RULE_TEXT[rule]}`]).join("; "));
    }
    if (rows.length === UPGRADE_FINDINGS_LIMIT) findings.more((database.prepare(`SELECT count(*) FROM "${entry.table}" WHERE ${where}`).pluck().get() as number) - rows.length);
  }
}

// ---------------------------------------------------------------------------
// The proposal pass

type SubjectKind = "registration" | "remote_identity";
interface Subject { id: string; name: unknown; status: unknown; parent: unknown; incarnation: number; version: number }
interface JournalEntry { sequence: number; kind: SubjectKind; subject: string; incarnation: number; project: string; basis: MappingNomination["basis"]; recordedAt: unknown }
interface Link { project: unknown; registration: unknown; linkedAt: unknown; unlinkedAt: unknown }
interface Binding { worker: unknown; identity: unknown; registration: unknown; revoked: unknown }
interface Worker { id: string; name: unknown; status: unknown; principalStatus: unknown }
type Outcome<Basis> = { projectId: string; basis: Basis; created: boolean; existing: boolean };
interface Creation { name: string; naming: ProjectNaming; sourceLength: number; kind: SubjectKind; subject: string }

const key = (kind: SubjectKind, id: string) => `${kind}\u0000${id}`;
const safe = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const SUBJECT_TABLE: Readonly<Record<SubjectKind, string>> = { registration: "projects", remote_identity: "remote_project_identities" };

/**
 * The project IDs this pass creates. A subject first gets the ID an earlier
 * plan of the same base and decisions gave it (`prior`), when that ID is still
 * free; otherwise a random UUID, the form the application uses for Knowledge
 * projects, when `fresh` allows it. Every ID is distinct from every ID in
 * `projects`, `knowledge_projects`, `remote_project_identities` and the
 * journal's projects, and from every other generated one. A replay (`fresh`
 * false) that cannot reuse the plan's ID refuses, naming the subject: the plan
 * is not the proposal.
 */
class ProjectIds {
  private readonly prior = new Map<string, string>();
  constructor(private readonly used: Set<string>, acts: readonly UpgradeAct[] | null, private readonly fresh: boolean) {
    for (const act of acts ?? []) {
      const payload = act.payload as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object" || payload.basis !== "created_project" || typeof payload.projectId !== "string") continue;
      const subject = act.kind === ATTACH_REGISTRATION ? payload.registrationId : act.kind === MAP_REMOTE_IDENTITY ? payload.remoteIdentityId : undefined;
      if (typeof subject === "string") this.prior.set(key(act.kind === ATTACH_REGISTRATION ? "registration" : "remote_identity", subject), payload.projectId);
    }
  }
  take(kind: SubjectKind, id: string): string {
    const candidate = this.prior.get(key(kind, id));
    if (candidate !== undefined && UUID.test(candidate) && !this.used.has(candidate)) { this.used.add(candidate); return candidate; }
    if (!this.fresh) {
      const refused = new FindingList();
      refused.add(SUBJECT_TABLE[kind], id, "the plan gives this subject no new project ID that is a UUID and still free");
      refused.raise("upgrade_plan_unproposed");
    }
    for (;;) {
      const generated = randomUUID();
      if (!this.used.has(generated)) { this.used.add(generated); return generated; }
    }
  }
}

function boundedRows<T>(database: Database.Database, table: string, sql: string, findings: FindingList): T[] {
  const rows = database.prepare(`${sql} LIMIT ${MAPPING_READ_LIMIT + 1}`).all() as T[];
  if (rows.length > MAPPING_READ_LIMIT) findings.add(table, table, `more than ${MAPPING_READ_LIMIT} rows`);
  return rows;
}
function grouped(database: Database.Database, sql: string): Map<string, number[]> {
  return new Map((database.prepare(sql).raw().all() as unknown[][]).filter(row => typeof row[0] === "string").map(row => [row[0] as string, row.slice(1).map(value => Number(value ?? 0))]));
}
function emptyCounts(): AuthorityRowCounts {
  return Object.fromEntries(PRINCIPAL_KINDS.map(kind => [kind, { unrevoked: 0, revoked: 0 }])) as AuthorityRowCounts;
}

/**
 * The single proposal pass: the complete ordered act list and the review for
 * this database, these normalised decisions and these project IDs. It gives
 * the same result at the source schema (49 or 50, where step 51's tables and
 * columns do not exist: an empty journal, stamps 0, no parent) and at 51,
 * inside the upgrade transaction after the structural steps, so apply can
 * recompute it. It writes nothing. A stop or an invalid decision is an
 * `UpgradeError` with the offending rows, bounded; nothing is truncated.
 */
export function proposeProjectMapping(database: Database.Database, context: UpgradeProposalContext, decisions: MappingDecisions,
  prior: readonly UpgradeAct[] | null, fresh: boolean): { acts: UpgradeAct[]; review: MappingReview } {
  gate();
  const mapped = context.schemaVersion >= PROJECT_MAPPING_VERSION;
  const bounds = new FindingList();
  const subjectCount = (database.prepare("SELECT (SELECT count(*) FROM projects)+(SELECT count(*) FROM remote_project_identities)").pluck().get() as number);
  if (subjectCount * 2 > UPGRADE_PLAN_LIMITS.acts) bounds.add("plan", "acts", `${subjectCount} registrations and remote identities may need more than ${UPGRADE_PLAN_LIMITS.acts} acts`);
  bounds.raise("upgrade_plan_bounds");

  // 0. Storage classes of every value read below, before any is used.
  const storage = new FindingList();
  storageClasses(database, mapped, storage);
  storage.raise("upgrade_mapping_malformed");
  // 0b. Identifiers compared or written back read back exactly (U+FFFD read back for an invalid stored sequence).
  const unreadable = new FindingList();
  texts(database, mapped, unreadable);
  unreadable.raise("upgrade_mapping_malformed");

  const stamps = mapped ? "parent_project_id AS parent,incarnation,mapping_version AS version" : "NULL AS parent,0 AS incarnation,0 AS version";
  const registrationRows = database.prepare(`SELECT id,name,NULL AS status,${stamps} FROM projects`).all() as Array<Record<string, unknown>>;
  const identityRows = database.prepare(`SELECT id,name,status,${stamps} FROM remote_project_identities`).all() as Array<Record<string, unknown>>;
  const projectRows = boundedRows<Record<string, unknown>>(database, "knowledge_projects", "SELECT id,name,status FROM knowledge_projects", bounds);
  const linkRows = boundedRows<Record<string, unknown>>(database, "knowledge_project_runtime_links",
    "SELECT knowledge_project_id AS project,runtime_project_id AS registration,linked_at AS linkedAt,unlinked_at AS unlinkedAt FROM knowledge_project_runtime_links", bounds);
  const bindingRows = boundedRows<Record<string, unknown>>(database, "remote_worker_project_grants",
    "SELECT worker_id AS worker,project_id AS identity,local_project_id AS registration,revoked_at AS revoked FROM remote_worker_project_grants", bounds);
  const workerRows = boundedRows<Record<string, unknown>>(database, "remote_workers",
    "SELECT w.id,w.name,w.status,p.status AS principalStatus FROM remote_workers w LEFT JOIN remote_principals p ON p.id=w.principal_id", bounds);
  const journalRows = mapped ? boundedRows<Record<string, unknown>>(database, "project_mapping_journal",
    "SELECT sequence,subject_kind AS kind,subject_id AS subject,subject_incarnation AS incarnation,project_id AS project,basis,recorded_at AS recordedAt FROM project_mapping_journal ORDER BY sequence", bounds) : [];
  bounds.raise("upgrade_plan_bounds");
  const clockRows = mapped ? database.prepare("SELECT value FROM project_mapping_clock WHERE singleton=1").all() as Array<{ value: unknown }> : [{ value: 0 }];

  // 1. Malformed stored values the proposal depends on.
  const malformed = new FindingList();
  const clockValue = clockRows.length === 1 ? clockRows[0].value : undefined;
  if (!safe(clockValue)) malformed.add("project_mapping_clock", "1", "missing or malformed clock");
  const clock = safe(clockValue) ? clockValue : 0;
  const subjects = (rows: Array<Record<string, unknown>>, table: string): Subject[] => rows.flatMap(row => {
    if (!journalId(row.id)) { malformed.add(table, typeof row.id === "string" ? row.id : `<${typeof row.id}>`, "ID is not bounded text"); return []; }
    if (!safe(row.incarnation) || !safe(row.version) || row.incarnation > clock || row.version > clock || (row.incarnation === 0) !== (row.version === 0)) { malformed.add(table, row.id, "malformed stamps"); return []; }
    if (row.parent !== null && typeof row.parent !== "string") { malformed.add(table, row.id, "malformed parent"); return []; }
    return [{ id: row.id, name: row.name, status: row.status, parent: row.parent, incarnation: row.incarnation, version: row.version }];
  });
  const registrations = subjects(registrationRows, "projects").sort((a, b) => compareText(a.id, b.id));
  const identities = subjects(identityRows, "remote_project_identities").sort((a, b) => compareText(a.id, b.id));
  const projects = new Map<string, { name: unknown; status: unknown }>();
  for (const row of projectRows) {
    if (typeof row.id !== "string" || row.id.length === 0) malformed.add("knowledge_projects", typeof row.id === "string" ? row.id : `<${typeof row.id}>`, "ID is not text");
    else projects.set(row.id, { name: row.name, status: row.status });
  }
  const links: Link[] = linkRows.map(row => ({ project: row.project, registration: row.registration, linkedAt: row.linkedAt, unlinkedAt: row.unlinkedAt }));
  for (const link of links) {
    if (typeof link.project !== "string" || (link.registration !== null && typeof link.registration !== "string") || typeof link.linkedAt !== "string" || (link.unlinkedAt !== null && typeof link.unlinkedAt !== "string")) {
      malformed.add("knowledge_project_runtime_links", typeof link.project === "string" ? link.project : `<${typeof link.project}>`, "malformed link");
    }
  }
  const bindings: Binding[] = bindingRows.map(row => ({ worker: row.worker, identity: row.identity, registration: row.registration, revoked: row.revoked }));
  for (const binding of bindings) {
    if (typeof binding.worker !== "string" || typeof binding.identity !== "string" || typeof binding.registration !== "string" || (binding.revoked !== null && typeof binding.revoked !== "string")) {
      malformed.add("remote_worker_project_grants", typeof binding.identity === "string" ? binding.identity : `<${typeof binding.identity}>`, "malformed binding");
    }
  }
  const workers = new Map<string, Worker>();
  for (const row of workerRows) {
    if (typeof row.id === "string") workers.set(row.id, { id: row.id, name: row.name, status: row.status, principalStatus: row.principalStatus });
    else malformed.add("remote_workers", `<${typeof row.id}>`, "ID is not text");
  }
  const journal: JournalEntry[] = [];
  const journalInconsistent = new FindingList();
  for (const row of journalRows) {
    const id = typeof row.subject === "string" ? row.subject : `<${typeof row.subject}>`;
    if (!safe(row.sequence, 1) || (row.kind !== "registration" && row.kind !== "remote_identity") || !journalId(row.subject) || !journalId(row.project)
      || !safe(row.incarnation, 1) || typeof row.basis !== "string" || !["created_project", "accepted_link", "accepted_binding", "journal_reuse"].includes(row.basis) || typeof row.recordedAt !== "string") {
      malformed.add("project_mapping_journal", id, "malformed journal row"); continue;
    }
    if ((row.basis === "accepted_link" && row.kind !== "registration") || (row.basis === "accepted_binding" && row.kind !== "remote_identity")) { journalInconsistent.add("project_mapping_journal", id, `entry ${row.sequence} has an illegal kind and basis`); continue; }
    if (row.incarnation > clock) { journalInconsistent.add("project_mapping_journal", id, `entry ${row.sequence} records an incarnation the clock has not issued`); continue; }
    journal.push({ sequence: row.sequence, kind: row.kind, subject: row.subject, incarnation: row.incarnation, project: row.project, basis: row.basis as JournalEntry["basis"], recordedAt: row.recordedAt });
  }
  malformed.raise("upgrade_mapping_malformed");

  // 2. Collisions: one ID string in more than one of the three ID tables.
  const collisions = new FindingList();
  const registrationIds = new Set(registrations.map(row => row.id)), identityIds = new Set(identities.map(row => row.id));
  for (const id of [...new Set([...registrationIds, ...projects.keys(), ...identityIds])].sort(compareText)) {
    const tables = [registrationIds.has(id) && "projects", projects.has(id) && "knowledge_projects", identityIds.has(id) && "remote_project_identities"].filter(Boolean) as string[];
    if (tables.length > 1) collisions.add(tables.join(","), id, `the same ID in ${tables.join(" and ")}`);
  }
  collisions.raise("upgrade_mapping_collision");

  // 3. Dangling references.
  const dangling = new FindingList();
  const current = links.filter(link => link.unlinkedAt === null && typeof link.registration === "string") as Array<Link & { project: string; registration: string }>;
  for (const link of current) {
    if (!registrationIds.has(link.registration)) dangling.add("knowledge_project_runtime_links", link.project, `current link names missing registration ${escapeDisplay(link.registration)}`);
    if (!projects.has(link.project)) dangling.add("knowledge_project_runtime_links", link.project, "current link names a missing project");
  }
  for (const binding of bindings as Array<Binding & { worker: string; identity: string; registration: string }>) {
    if (!workers.has(binding.worker)) dangling.add("remote_worker_project_grants", binding.identity, `binding names missing worker ${escapeDisplay(binding.worker)}`);
    if (!identityIds.has(binding.identity)) dangling.add("remote_worker_project_grants", binding.identity, "binding names a missing remote identity");
    if (!registrationIds.has(binding.registration)) dangling.add("remote_worker_project_grants", binding.identity, `binding names missing registration ${escapeDisplay(binding.registration)}`);
  }
  for (const [table, rows] of [["projects", registrations], ["remote_project_identities", identities]] as const) {
    for (const row of rows) if (typeof row.parent === "string" && !projects.has(row.parent)) dangling.add(table, row.id, "parent names a missing project");
  }
  dangling.raise("upgrade_mapping_dangling");

  // 4. Unexpected mapping state: a parent while the upgrade is needed (a quarantine clears every parent).
  const unexpected = new FindingList();
  for (const [table, rows] of [["projects", registrations], ["remote_project_identities", identities]] as const) {
    for (const row of rows) if (row.parent !== null) unexpected.add(table, row.id, "has a parent project while the upgrade is needed");
  }
  unexpected.raise("upgrade_mapping_unexpected");

  // 5. Journal consistency: one creation per project, never after an acceptance of it.
  const created = new Map<string, JournalEntry[]>(), acceptedBefore = new Map<string, number>();
  for (const entry of journal) {
    if (entry.basis === "created_project") {
      const list = created.get(entry.project);
      if (list) list.push(entry); else created.set(entry.project, [entry]);
      const earlier = acceptedBefore.get(entry.project);
      if (earlier !== undefined) journalInconsistent.add("project_mapping_journal", entry.project, `created by entry ${entry.sequence} after its acceptance in entry ${earlier}`);
    }
    if ((entry.basis === "accepted_link" || entry.basis === "accepted_binding") && !acceptedBefore.has(entry.project)) acceptedBefore.set(entry.project, entry.sequence);
  }
  for (const [project, entries] of created) {
    if (entries.length > 1) journalInconsistent.add("project_mapping_journal", project, `created by ${entries.length} entries (${sampled(entries.map(entry => String(entry.sequence)))})`);
  }
  journalInconsistent.raise("upgrade_mapping_journal");

  // 6. The decisions must name existing rows.
  const invalid = new FindingList();
  const currentLink = new Map(current.map(link => [link.registration, link]));
  for (const entry of decisions.links) {
    const link = currentLink.get(entry.registrationId);
    if (!link || link.project !== entry.projectId) invalid.add("decisions.links", entry.registrationId, "names no current link of this registration to this project");
    else if (!journalId(entry.projectId)) invalid.add("decisions.links", entry.registrationId, "the linked project's ID cannot be recorded in the journal");
  }
  const pair = (identity: string, registration: string) => `${identity}\u0000${registration}`;
  const bindingPairs = new Set(bindings.map(binding => pair(binding.identity as string, binding.registration as string)));
  for (const entry of decisions.bindings) {
    if (!bindingPairs.has(pair(entry.remoteIdentityId, entry.registrationId))) invalid.add("decisions.bindings", entry.remoteIdentityId, `names no binding to registration ${escapeDisplay(entry.registrationId)}`);
  }
  for (const id of decisions.isolate.registrations) if (!registrationIds.has(id)) invalid.add("decisions.isolate.registrations", id, "names no registration");
  for (const id of decisions.isolate.remoteIdentities) if (!identityIds.has(id)) invalid.add("decisions.isolate.remoteIdentities", id, "names no remote identity");
  invalid.raise("upgrade_decisions_invalid");

  // 7. Outcomes.
  const latest = new Map<string, JournalEntry>();
  for (const entry of journal) latest.set(key(entry.kind, entry.subject), entry);
  const used = new Set<string>([...registrationIds, ...projects.keys(), ...identityIds, ...journal.map(entry => entry.project)]);
  const ids = new ProjectIds(used, prior, fresh);
  const nominate = (kind: SubjectKind, row: Subject): { nomination: MappingNomination | null; eligible: boolean } => {
    const entry = latest.get(key(kind, row.id));
    if (!entry) return { nomination: null, eligible: false };
    const creations = created.get(entry.project) ?? [];
    const reason: NominationReason = entry.basis !== "created_project" && entry.basis !== "journal_reuse" ? "accepted_basis"
      : !projects.has(entry.project) ? "project_missing"
        : row.incarnation === 0 ? "unstamped"
          : entry.incarnation !== row.incarnation ? "incarnation_changed"
            : creations.length !== 1 || creations[0].kind !== kind || creations[0].subject !== row.id || creations[0].incarnation !== row.incarnation ? "provenance"
              : "used";
    return {
      nomination: { sequence: entry.sequence, recordedAt: escapeDisplay(entry.recordedAt, 64), projectId: entry.project, basis: entry.basis, incarnation: entry.incarnation, used: false, reason },
      eligible: reason === "used",
    };
  };
  // The new projects: their derived names and the subject each is created for.
  const creations = new Map<string, Creation>();
  const create = (kind: SubjectKind, row: Subject): string => {
    const projectId = ids.take(kind, row.id);
    if (typeof row.name !== "string") malformed.add(SUBJECT_TABLE[kind], row.id, "name is not text");
    else creations.set(projectId, { ...deriveProjectName(kind, row.id, row.name), sourceLength: row.name.length, kind, subject: row.id });
    return projectId;
  };
  const acceptedLinks = new Map(decisions.links.map(entry => [entry.registrationId, entry.projectId]));
  const isolatedRegistrations = new Set(decisions.isolate.registrations), isolatedIdentities = new Set(decisions.isolate.remoteIdentities);
  const registrationOutcomes = new Map<string, Outcome<RegistrationBasis>>();
  const registrationNominations = new Map<string, MappingNomination | null>();
  for (const row of registrations) {
    const { nomination, eligible } = nominate("registration", row);
    let outcome: Outcome<RegistrationBasis>;
    const linked = acceptedLinks.get(row.id);
    if (linked !== undefined) outcome = { projectId: linked, basis: "accepted_link", created: false, existing: true };
    else if (isolatedRegistrations.has(row.id)) outcome = { projectId: create("registration", row), basis: "created_project", created: true, existing: false };
    else if (eligible && nomination) outcome = { projectId: nomination.projectId, basis: "journal_reuse", created: false, existing: true };
    else outcome = { projectId: create("registration", row), basis: "created_project", created: true, existing: false };
    if (nomination) {
      nomination.used = outcome.basis === "journal_reuse";
      if (eligible && !nomination.used) nomination.reason = linked !== undefined ? "accepted_decision" : "isolated";
    }
    registrationOutcomes.set(row.id, outcome);
    registrationNominations.set(row.id, nomination);
  }
  const bindingsOf = new Map<string, Array<Binding & { worker: string; identity: string; registration: string }>>();
  for (const binding of bindings as Array<Binding & { worker: string; identity: string; registration: string }>) {
    const list = bindingsOf.get(binding.identity);
    if (list) list.push(binding); else bindingsOf.set(binding.identity, [binding]);
  }
  const acceptedBindings = new Map<string, Set<string>>();
  for (const entry of decisions.bindings) acceptedBindings.set(entry.remoteIdentityId, (acceptedBindings.get(entry.remoteIdentityId) ?? new Set()).add(entry.registrationId));
  const divergent = new FindingList();
  const identityOutcomes = new Map<string, Outcome<IdentityBasis>>();
  const identityNominations = new Map<string, MappingNomination | null>();
  const destinations = (registrationIdsOf: Iterable<string>) => [...new Set([...registrationIdsOf].map(id => registrationOutcomes.get(id)!.projectId))].sort(compareText);
  for (const row of identities) {
    const { nomination, eligible } = nominate("remote_identity", row);
    const accepted = acceptedBindings.get(row.id);
    let outcome: Outcome<IdentityBasis> | undefined;
    if (accepted) {
      const targets = destinations(accepted);
      if (targets.length > 1) divergent.add("remote_project_identities", row.id, `accepted bindings lead to projects ${sampled(targets.map(id => escapeDisplay(id) ?? ""))}`);
      // The registration's destination: an existing project, or the one this plan creates for that registration.
      else outcome = { projectId: targets[0], basis: "accepted_binding", created: false, existing: projects.has(targets[0]) };
    } else if (isolatedIdentities.has(row.id)) outcome = { projectId: create("remote_identity", row), basis: "created_project", created: true, existing: false };
    else {
      const targets = destinations((bindingsOf.get(row.id) ?? []).map(binding => binding.registration));
      if (targets.length > 1) divergent.add("remote_project_identities", row.id, `bindings lead to projects ${sampled(targets.map(id => escapeDisplay(id) ?? ""))}; accept a consistent set or isolate it`);
      else if (eligible && nomination) outcome = { projectId: nomination.projectId, basis: "journal_reuse", created: false, existing: true };
      else outcome = { projectId: create("remote_identity", row), basis: "created_project", created: true, existing: false };
    }
    if (!outcome) continue;
    if (nomination) {
      nomination.used = outcome.basis === "journal_reuse";
      if (eligible && !nomination.used) nomination.reason = accepted ? "accepted_decision" : "isolated";
    }
    identityOutcomes.set(row.id, outcome);
    identityNominations.set(row.id, nomination);
  }
  divergent.raise("upgrade_mapping_divergent");
  malformed.raise("upgrade_mapping_malformed");
  // Every destination is an existing project or one this plan creates; nothing else can be attached to.
  for (const outcome of [...registrationOutcomes.values(), ...identityOutcomes.values()]) {
    if (outcome.existing !== projects.has(outcome.projectId) || (!outcome.existing && !creations.has(outcome.projectId)) || outcome.created !== (outcome.basis === "created_project")) {
      throw new Error("Project mapping proposal produced an inconsistent destination.");
    }
  }

  // 7b. The clock advances once per attach and map act; refuse now, before any backup or witness, if it cannot.
  const advances = registrationOutcomes.size + identityOutcomes.size;
  if (advances > MAPPING_CLOCK_MAX - clock) {
    const exhausted = new FindingList();
    exhausted.add("project_mapping_clock", "1", `the clock at ${clock} cannot advance ${advances} times (its maximum is ${MAPPING_CLOCK_MAX})`);
    exhausted.raise("upgrade_mapping_clock");
  }

  // 8. Acts: every creation, then every attachment, then every mapping, each by subject ID.
  const acts: UpgradeAct[] = [];
  for (const [rows, outcomes] of [[registrations, registrationOutcomes], [identities, identityOutcomes]] as const) {
    for (const row of rows) {
      const outcome = (outcomes as Map<string, Outcome<string>>).get(row.id)!;
      if (outcome.created) acts.push({ kind: CREATE_PROJECT, payload: { projectId: outcome.projectId, name: creations.get(outcome.projectId)!.name } });
    }
  }
  for (const row of registrations) {
    const outcome = registrationOutcomes.get(row.id)!;
    acts.push({ kind: ATTACH_REGISTRATION, payload: { registrationId: row.id, projectId: outcome.projectId, basis: outcome.basis } });
  }
  for (const row of identities) {
    const outcome = identityOutcomes.get(row.id)!;
    acts.push({ kind: MAP_REMOTE_IDENTITY, payload: { remoteIdentityId: row.id, projectId: outcome.projectId, basis: outcome.basis } });
  }
  if (acts.length > UPGRADE_PLAN_LIMITS.acts) { bounds.add("plan", "acts", `${acts.length} acts exceed ${UPGRADE_PLAN_LIMITS.acts}`); bounds.raise("upgrade_plan_bounds"); }

  // 9. The review.
  const vaults = grouped(database, "SELECT project_id,count(*) FROM dev_environment_vaults GROUP BY project_id");
  const reservations = grouped(database, "SELECT project_id,count(*),sum(released_at IS NULL) FROM reservations GROUP BY project_id");
  const testRuns = grouped(database, "SELECT project_id,count(*) FROM test_runs GROUP BY project_id");
  const profiles = new Map((database.prepare(`SELECT id,CASE WHEN typeof(environment_profiles_json)='text' AND json_valid(environment_profiles_json)
    AND json_type(environment_profiles_json)='array' THEN json_array_length(environment_profiles_json) END FROM projects`).raw().all() as Array<[unknown, number | null]>)
    .filter(row => typeof row[0] === "string").map(row => [row[0] as string, row[1]]));
  const requests = grouped(database, "SELECT project_id,count(*) FROM remote_verification_requests GROUP BY project_id");
  const attempts = grouped(database, "SELECT r.project_id,count(*) FROM remote_verification_attempts a JOIN remote_verification_requests r ON r.id=a.request_id GROUP BY r.project_id");
  const lastChange = database.prepare(`SELECT h.operation,h.principal_id AS principalId,p.kind AS principalKind,h.authentication_method AS authenticationMethod,h.created_at AS at
    FROM knowledge_history h LEFT JOIN remote_principals p ON p.id=h.principal_id
    WHERE h.project_id=? AND h.record_kind='project' AND h.record_id=? AND h.operation IN ('linked','unlinked') ORDER BY h.id DESC LIMIT 1`);
  const accepted = new Set(decisions.links.map(entry => entry.registrationId));
  const registrationReviews: RegistrationReview[] = registrations.map(row => {
    const link = currentLink.get(row.id);
    const change = link ? lastChange.get(link.project, link.project) as Record<string, unknown> | undefined : undefined;
    return {
      id: row.id, name: escapeDisplay(row.name), incarnation: row.incarnation, outcome: registrationOutcomes.get(row.id)!,
      link: link ? {
        projectId: link.project, linkedAt: escapeDisplay(link.linkedAt, 64), accepted: accepted.has(row.id),
        lastChange: change ? { operation: escapeDisplay(change.operation, 64), principalId: escapeDisplay(change.principalId), principalKind: escapeDisplay(change.principalKind, 64),
          authenticationMethod: escapeDisplay(change.authenticationMethod, 64), at: escapeDisplay(change.at, 64) } : null,
      } : null,
      nomination: registrationNominations.get(row.id) ?? null,
      inventory: { vaultRecords: vaults.get(row.id)?.[0] ?? 0, reservations: reservations.get(row.id)?.[0] ?? 0, activeReservations: reservations.get(row.id)?.[1] ?? 0,
        testRuns: testRuns.get(row.id)?.[0] ?? 0, environmentProfiles: profiles.get(row.id) ?? null },
    };
  });
  const identityReviews: RemoteIdentityReview[] = identities.map(row => {
    const acceptedHere = acceptedBindings.get(row.id) ?? new Set<string>();
    return {
      id: row.id, name: escapeDisplay(row.name), status: escapeDisplay(row.status, 64), incarnation: row.incarnation, outcome: identityOutcomes.get(row.id)!,
      bindings: (bindingsOf.get(row.id) ?? []).sort((a, b) => compareText(a.worker, b.worker)).map(binding => {
        const worker = workers.get(binding.worker)!;
        return { workerId: binding.worker, workerName: escapeDisplay(worker.name), workerStatus: escapeDisplay(worker.status, 64), workerPrincipalStatus: escapeDisplay(worker.principalStatus, 64),
          registrationId: binding.registration, revoked: binding.revoked !== null, accepted: acceptedHere.has(binding.registration) };
      }),
      nomination: identityNominations.get(row.id) ?? null,
      inventory: { requests: requests.get(row.id)?.[0] ?? 0, attempts: attempts.get(row.id)?.[0] ?? 0 },
    };
  });
  // Subjects by destination and by the journal's last project, indexed once (the subject lists are already sorted by ID).
  const index = (pairs: Iterable<readonly [string, string]>) => {
    const result = new Map<string, string[]>();
    for (const [project, subject] of pairs) { const list = result.get(project); if (list) list.push(subject); else result.set(project, [subject]); }
    return result;
  };
  const joiners = { registration: index([...registrationOutcomes].map(([subject, outcome]) => [outcome.projectId, subject] as const)),
    remote_identity: index([...identityOutcomes].map(([subject, outcome]) => [outcome.projectId, subject] as const)) };
  const journaled = { registration: index([...latest.values()].filter(entry => entry.kind === "registration").map(entry => [entry.project, entry.subject] as const)),
    remote_identity: index([...latest.values()].filter(entry => entry.kind === "remote_identity").map(entry => [entry.project, entry.subject] as const)) };
  const joining = (kind: SubjectKind, id: string) => [...(joiners[kind].get(id) ?? [])].sort(compareText);
  // Projects this plan creates: the name each gets and every subject that joins it.
  const newProjectReviews: NewProjectReview[] = [...creations].sort(([a], [b]) => compareText(a, b)).map(([id, creation]) => ({
    id, name: escapeDisplay(creation.name) ?? "", naming: creation.naming, sourceLength: creation.sourceLength, createdFor: { kind: creation.kind, id: creation.subject },
    registrations: joining("registration", id), remoteIdentities: joining("remote_identity", id),
  }));
  // Existing destination projects: what the plan puts together there, and the authority rows stored for it now.
  const existing = [...new Set([...registrationOutcomes.values(), ...identityOutcomes.values()].filter(outcome => outcome.existing).map(outcome => outcome.projectId))].sort(compareText);
  const principalKind = new FindingList();
  const counter = (sql: string) => {
    const statement = database.prepare(sql);
    return (ids: readonly string[]): AuthorityRowCounts => {
      const result = emptyCounts();
      for (const id of ids) for (const row of statement.all(id) as Array<{ kind: unknown; unrevoked: unknown }>) {
        if (!PRINCIPAL_KINDS.includes(row.kind as PrincipalKind)) { principalKind.add("remote_principals", id, "a principal of unknown kind holds authority here"); continue; }
        result[row.kind as PrincipalKind][row.unrevoked ? "unrevoked" : "revoked"]++;
      }
      return result;
    };
  };
  const knowledgeGrants = counter("SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM knowledge_project_grants g LEFT JOIN remote_principals p ON p.id=g.principal_id WHERE g.project_id=?");
  const roleBindings = counter("SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM knowledge_role_bindings g LEFT JOIN remote_principals p ON p.id=g.principal_id WHERE g.project_id=?");
  const runtimeDelegations = counter("SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM runtime_delegations g LEFT JOIN remote_principals p ON p.id=g.principal_id WHERE g.project_id=?");
  const runtimeMemberships = counter("SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM runtime_human_memberships g LEFT JOIN remote_principals p ON p.id=g.principal_id WHERE g.project_id=?");
  const credentialScopes = counter(`SELECT p.kind,c.status='active' AS unrevoked FROM runtime_credential_scopes s LEFT JOIN principal_credentials c ON c.id=s.credential_id
    LEFT JOIN remote_principals p ON p.id=c.principal_id WHERE s.project_id=?`);
  const workerBindings = counter(`SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM remote_worker_project_grants g LEFT JOIN remote_workers w ON w.id=g.worker_id
    LEFT JOIN remote_principals p ON p.id=w.principal_id WHERE g.local_project_id=?`);
  const remotePrincipalGrants = counter("SELECT p.kind,g.revoked_at IS NULL AS unrevoked FROM remote_principal_project_grants g LEFT JOIN remote_principals p ON p.id=g.principal_id WHERE g.project_id=?");
  const inventory = Object.fromEntries(([
    ["threads", "knowledge_threads", "project_id"], ["replies", "knowledge_replies", "project_id"], ["tasks", "knowledge_tasks", "project_id"],
    ["memories", "knowledge_memories", "project_id"], ["attachments", "knowledge_attachments", "project_id"], ["history", "knowledge_history", "project_id"],
    ["importBatches", "knowledge_import_batches", "target_project_id"],
  ] as const).map(([name, table, column]) => [name, database.prepare(`SELECT count(*) FROM ${table} WHERE ${column}=?`).pluck()]));
  const projectReviews: ProjectReview[] = existing.map(id => {
    const members = (kind: SubjectKind, outcomes: Map<string, { projectId: string }>, present: Set<string>) => {
      const ids = new Set<string>([...(joiners[kind].get(id) ?? []), ...(journaled[kind].get(id) ?? [])]);
      return [...ids].sort(compareText).map(subject => ({ id: subject, plan: outcomes.get(subject)?.projectId === id, journal: latest.get(key(kind, subject))?.project === id, present: present.has(subject) }));
    };
    const attached = joining("registration", id), mappedHere = joining("remote_identity", id);
    const project = projects.get(id)!;
    return {
      id, name: escapeDisplay(project.name), status: escapeDisplay(project.status, 64),
      inventory: Object.fromEntries(Object.entries(inventory).map(([name, statement]) => [name, statement.get(id) as number])) as ProjectReview["inventory"],
      registrations: members("registration", registrationOutcomes, registrationIds), remoteIdentities: members("remote_identity", identityOutcomes, identityIds),
      authorityRows: {
        knowledgeGrants: knowledgeGrants([id]), roleBindings: roleBindings([id]), runtimeDelegations: runtimeDelegations(attached), runtimeMemberships: runtimeMemberships(attached),
        credentialScopes: credentialScopes(attached), workerBindings: workerBindings(attached), remotePrincipalGrants: remotePrincipalGrants(mappedHere),
      },
    };
  });
  principalKind.raise("upgrade_mapping_malformed");
  const destinationsAll = new Set([...registrationOutcomes.values(), ...identityOutcomes.values()].map(outcome => outcome.projectId));
  const review: MappingReview = {
    registrations: registrationReviews, remoteIdentities: identityReviews, projects: projectReviews, newProjects: newProjectReviews,
    untouchedProjects: [...projects.keys()].filter(id => !destinationsAll.has(id)).length,
  };
  return { acts, review };
}

// ---------------------------------------------------------------------------
// The operator's lines

const shown = (value: string | null) => value === null ? "(none)" : `"${value}"`;
const ident = (value: string) => escapeDisplay(value) ?? "";
const counts = (value: AuthorityRowCounts) => PRINCIPAL_KINDS.map(kind => `${kind} ${value[kind].unrevoked} unrevoked/${value[kind].revoked} revoked`).join(", ");
const BASIS: Readonly<Record<string, string>> = {
  created_project: "a new project created for it", accepted_link: "its existing link, accepted by the operator",
  accepted_binding: "its accepted worker bindings", journal_reuse: "the project the journal nominates",
};
const REASONS: Readonly<Record<NominationReason, string>> = {
  used: "used", isolated: "declined by isolate", accepted_decision: "not used: an accepted decision takes precedence",
  accepted_basis: "not used: an acceptance of a pre-existing project needs the decision again", project_missing: "not used: the project no longer exists",
  unstamped: "not used: the row is not stamped", incarnation_changed: "not used: the row was removed and created again since (another incarnation)",
  provenance: "not used: the project was not created for exactly this subject",
};
interface NamingFacts { sourceLength: number; length: number; subject: string }
const NAMING: Readonly<Record<ProjectNaming, (facts: NamingFacts) => string>> = {
  copied: () => "its name copied",
  trimmed: () => "its name without the surrounding whitespace",
  shortened: ({ sourceLength, length }) => `its name trimmed and shortened from ${sourceLength} to ${length} characters, the application's limit being ${PROJECT_NAME_LIMIT}`,
  replaced: ({ subject }) => `its name replaced, since the ${subject}'s name is empty after trimming`,
};
const subjectLabel = (kind: "registration" | "remote_identity", id: string) => `${kind === "registration" ? "registration" : "remote identity"} ${ident(id)}`;
const LIST_LIMIT = 20;
function nominationLine(nomination: MappingNomination | null, outcome: { projectId: string; basis: string }): string[] {
  if (!nomination) return [];
  // A nomination not used as the basis may still name the project the subject joins by another basis: say so.
  const same = !nomination.used && outcome.projectId === nomination.projectId ? ` The subject joins that project anyway, by another basis: ${BASIS[outcome.basis]}.` : "";
  return [`  Journal nomination (entry ${nomination.sequence}, recorded ${nomination.recordedAt ?? "(not text)"}, basis ${nomination.basis}): project ${ident(nomination.projectId)}; ${REASONS[nomination.reason]}.`
    + (nomination.used ? " It is a nomination from history: approve it through the plan hash, or decline it with isolate." : "") + same];
}

/** The operator's lines for the mapping acts and their review. */
export function describeProjectMapping(acts: readonly UpgradeAct[], review: MappingReview): string[] {
  const lines: string[] = [];
  const created = new Map(review.newProjects.map(project => [project.id, project]));
  const createdFor = (id: string) => { const project = created.get(id); return project ? subjectLabel(project.createdFor.kind, project.createdFor.id) : "(no subject)"; };
  for (const act of acts) {
    if (act.kind !== CREATE_PROJECT) continue;
    const payload = act.payload as CreateProjectPayload;
    const project = created.get(payload.projectId);
    const naming = project ? `; ${NAMING[project.naming]({ sourceLength: project.sourceLength, length: payload.name.length, subject: project.createdFor.kind === "registration" ? "registration" : "remote identity" })}` : "";
    lines.push(`Create project ${payload.projectId} ${shown(escapeDisplay(payload.name))} for ${createdFor(payload.projectId)}${naming}.`);
    if (project) {
      const joiners = [...project.registrations.map(id => subjectLabel("registration", id)), ...project.remoteIdentities.map(id => subjectLabel("remote_identity", id))];
      lines.push(`  New project: no Knowledge content and no stored grants or role bindings. Joined in this plan by ${sampled(joiners, LIST_LIMIT)}.`);
    }
  }
  const destination = (outcome: { projectId: string; existing: boolean; created: boolean }) => outcome.existing ? `existing project ${ident(outcome.projectId)}`
    : outcome.created ? `new project ${ident(outcome.projectId)}` : `new project ${ident(outcome.projectId)} (created in this plan for ${createdFor(outcome.projectId)})`;
  for (const row of review.registrations) {
    lines.push(`Attach registration ${ident(row.id)} ${shown(row.name)} to ${destination(row.outcome)}: ${BASIS[row.outcome.basis]}.`);
    if (row.link) {
      // Only what is true of the link: whether it is the accepted basis, and whether the registration joins its project at all.
      const joins = row.outcome.projectId === row.link.projectId;
      const verdict = row.link.accepted ? "accepted as the basis; the registration joins that project"
        : joins ? `not accepted as the basis; the registration joins that project anyway, by another basis: ${BASIS[row.outcome.basis]}`
          : "not accepted; the registration does not join that project in this plan";
      lines.push(`  Existing link to project ${ident(row.link.projectId)} since ${row.link.linkedAt ?? "(not text)"}: ${verdict}.`);
      if (row.link.lastChange) {
        const change = row.link.lastChange;
        lines.push(`  Recorded history, not an approval: the last link change (${change.operation ?? "?"}) was attributed to principal ${change.principalId ?? "?"} (${change.principalKind ?? "unknown kind"}, ${change.authenticationMethod ?? "?"}) at ${change.at ?? "?"}.`);
      }
    }
    lines.push(...nominationLine(row.nomination, row.outcome));
    const inventory = row.inventory;
    lines.push(`  Inventory: ${inventory.vaultRecords} Vault record(s) (profiles are inside the ciphertext and not read), ${inventory.reservations} claim(s) or reservation(s) (${inventory.activeReservations} active), ${inventory.testRuns} test run(s), ${inventory.environmentProfiles ?? "unreadable"} environment profile(s).`);
  }
  for (const row of review.remoteIdentities) {
    lines.push(`Map remote identity ${ident(row.id)} ${shown(row.name)} (${row.status ?? "?"}) to ${destination(row.outcome)}: ${BASIS[row.outcome.basis]}.`);
    for (const binding of row.bindings) {
      lines.push(`  Binding: worker ${ident(binding.workerId)} ${shown(binding.workerName)} (worker ${binding.workerStatus ?? "?"}, principal ${binding.workerPrincipalStatus ?? "?"}), registration ${ident(binding.registrationId)}, ${binding.revoked ? "revoked" : "not revoked"}, ${binding.accepted ? "accepted" : "not accepted"}.`);
    }
    if (row.bindings.some(binding => binding.accepted)) lines.push("  Accepting a binding accepts every worker row of that remote identity and registration; no grant is changed or restored.");
    lines.push(...nominationLine(row.nomination, row.outcome));
    lines.push(`  Inventory: ${row.inventory.requests} verification request(s), ${row.inventory.attempts} attempt(s).`);
  }
  for (const project of review.projects) {
    const inventory = project.inventory;
    lines.push(`Existing project ${ident(project.id)} ${shown(project.name)} (${project.status ?? "?"}): ${inventory.threads} thread(s), ${inventory.replies} reply(ies), ${inventory.tasks} task(s), ${inventory.memories} memory(ies), ${inventory.attachments} attachment(s), ${inventory.history} history row(s), ${inventory.importBatches} import batch(es).`);
    for (const [label, members] of [["registration", project.registrations], ["remote identity", project.remoteIdentities]] as const) {
      for (const member of members) lines.push(`  ${label} ${ident(member.id)}: ${[member.plan && "joins it in this plan", member.journal && "the journal last associated it", !member.present && "no longer exists"].filter(Boolean).join("; ")}.`);
    }
    const rows = project.authorityRows;
    lines.push("  Stored authority rows by principal kind, each counted by its own revocation field (a credential scope by its credential's stored status): row counts, not distinct principals and not effective access; a revoked principal or an expired credential is not taken into account.");
    lines.push(`  Knowledge grants: ${counts(rows.knowledgeGrants)}. Role bindings: ${counts(rows.roleBindings)}.`);
    lines.push(`  On the registrations this plan attaches: delegations ${counts(rows.runtimeDelegations)}; memberships ${counts(rows.runtimeMemberships)}; credential scopes ${counts(rows.credentialScopes)}; worker bindings ${counts(rows.workerBindings)}.`);
    lines.push(`  On the remote identities this plan maps: principal grants ${counts(rows.remotePrincipalGrants)}.`);
    lines.push("  Grant tables keep only the latest value of each grant; they are not a complete history.");
  }
  lines.push(`${review.untouchedProjects} other project(s) are not touched.`);
  return lines;
}

/** The mapping domain of the upgrade: from target 51 on, with the decision keys `links`, `bindings` and `isolate`. */
export const MAPPING_ACT_DOMAIN: UpgradeActDomain<MappingDecisions, MappingReview> = Object.freeze({
  name: "mapping",
  minimumTarget: PROJECT_MAPPING_VERSION,
  decisionKeys: Object.freeze(["links", "bindings", "isolate"]),
  decisions: storedDecisionsSchema,
  review: reviewSchema as unknown as z.ZodType<MappingReview>,
  kinds,
  normalise: normaliseMappingDecisions,
  propose: proposeProjectMapping,
  describe: describeProjectMapping,
});
