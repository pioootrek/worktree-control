import { readdirSync, readFileSync, realpathSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../../paths";
import { schemaTarget, SECURITY_FENCE_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { OwnedSqliteDatabase } from "./owned-database";
import { establishSqliteSecurityFence, maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { parseManifest } from "./backup-validation";
import { cancelRemoteWork, interruptTestRuns, releaseReservations, revokeCredentials, revokeOldGrants } from "./authority-reset";
import { applySqliteUpgrade, inspectSqliteUpgrade } from "./upgrade-maintenance";
import { upgradeTarget } from "./upgrade-plan";
import { schemaAt49 } from "./fixtures/released-schema";

/**
 * Where the schema entry points may be used, now that the supported schema is
 * 53 and the upgrade, fence establishment with a backup and the ordinary
 * admission are mounted. Successor of `provisional-schema.test.ts`, whose gate
 * no longer exists.
 *
 * Rules (non-test files under `src/`, extensions in SOURCE_EXTENSIONS, names not
 * matching TEST_FILE; fixtures under `src/` are scanned too):
 *
 * 1. Step modules: imports of the step modules (STEP_MODULES) are confined to
 *    the importer and module pairs of STEP_IMPORTS. Only the store imports
 *    the project directory and grants reader, exposing structural ports for
 *    the still-unmounted operations adapters; the authority reset is
 *    imported only by the quarantine and the authority acts; the recovery's
 *    predictor only by the authority acts; the exact-text check only by the
 *    predictor and both act domains.
 * 2. Grants: the text `account_grants` appears only in GRANTS_TEXT_FILES, so
 *    the store's port reads it only through the listed reader (rule 1).
 * 3. Mounted entry points: the upgrade composition is imported only by its
 *    command runner (and the test-side fixture), the runner only by the CLI
 *    entry; each entry point of ENTRY_OCCURRENCES is written only in the file
 *    and context listed: the upgrade and the establishment with a backup only
 *    from their CLI commands, the admission check only from the constructor of
 *    `OwnedSqliteDatabase`. A string literal equal to an entry point's name is
 *    refused everywhere, and so is an `export *` of a module that carries one.
 * 4. Openings: every construction of `SqliteStateStore` and
 *    `OwnedSqliteDatabase`, every direct `better-sqlite3` open and every call
 *    of `acquireDatabaseOwnership` is listed in OPENINGS with its file,
 *    context, arguments and class (ordinary, maintenance, ownership, test
 *    support); a new or changed one fails until it is classified. Ordinary
 *    owners pass `{ ordinary: true }` at the default ceiling; production stores
 *    construct their own owner; maintenance owners never pass `ordinary`.
 *
 * Limits: literal specifiers only (non-literal ones fail `unmounted.test.ts` in
 * `src/server/modules/operations` under `src`); files outside `src/`, test
 * files and files that are not scripts are not scanned; a computed access
 * (`sqlite[name]`), a value passed out of an allowed body, or a construction
 * through an alias of the class (`const C = SqliteStateStore; new C()`) cannot
 * be caught by a syntactic guard.
 */
const SQLITE = "src/server/infrastructure/sqlite";
const MARKER_STEP = `${SQLITE}/upgrade-marker-migration.ts`, COVERAGE = `${SQLITE}/security-coverage.ts`;
const MAPPING_STEP = `${SQLITE}/mapping-structure-migration.ts`, DIRECTORY = `${SQLITE}/project-directory-queries.ts`;
const MAPPING_ACTS = `${SQLITE}/mapping-upgrade-acts.ts`;
const GRANTS_STEP = `${SQLITE}/account-grants-migration.ts`, AUTHORITY_ACTS = `${SQLITE}/authority-upgrade-acts.ts`;
const GRANTS_READER = `${SQLITE}/account-grants-queries.ts`;
const STORE = `${SQLITE}/sqlite-state-store.ts`;
const AUTHORITY_RESET = `${SQLITE}/authority-reset.ts`, RECOVERY_PREDICTION = `${SQLITE}/test-run-recovery-prediction.ts`, STORED_TEXT = `${SQLITE}/stored-text.ts`;
const STEP_MODULES = Object.freeze([MARKER_STEP, COVERAGE, MAPPING_STEP, DIRECTORY, MAPPING_ACTS, GRANTS_STEP, GRANTS_READER, AUTHORITY_ACTS, AUTHORITY_RESET, RECOVERY_PREDICTION,
  STORED_TEXT]);
/**
 * The only non-test importers of the step modules, each with the modules it may
 * import and why. The store exposes the directory and grants readers on its
 * owned core connection; no operations adapter is mounted.
 */
const STEP_IMPORTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  [STORE]: { [DIRECTORY]: "exposes synchronous project directory reads on the owned core connection",
    [GRANTS_READER]: "exposes synchronous account grants reads on the owned core connection" },
  [COVERAGE]: { [MARKER_STEP]: "lists step 50's fence coverage", [MAPPING_STEP]: "lists step 51's fence coverage and its other triggers",
    [GRANTS_STEP]: "lists step 52's fence coverage and its other triggers" },
  [`${SQLITE}/migrations.ts`]: { [MARKER_STEP]: "applies step 50 when initializeSchema is given the target", [MAPPING_STEP]: "applies step 51 when initializeSchema is given the target",
    [GRANTS_STEP]: "applies step 52 when initializeSchema is given the target" },
  [`${SQLITE}/schema-inspection.ts`]: { [MARKER_STEP]: "recognises step 50 by its text and checksum", [COVERAGE]: "builds the expected triggers of each version",
    [MAPPING_STEP]: "recognises step 51's tables, columns and checksum at ceiling 51", [GRANTS_STEP]: "recognises step 52's name and checksum at ceiling 52" },
  [`${SQLITE}/fixtures/schema-rewind.ts`]: { [MARKER_STEP]: "rewinds synthetic step-50 fixtures", [MAPPING_STEP]: "rewinds synthetic step-51 fixtures", [GRANTS_STEP]: "rewinds synthetic step-52 fixtures" },
  [`${SQLITE}/upgrade-plan.ts`]: { [MARKER_STEP]: "names step 50 and its checksum among the structural steps", [MAPPING_STEP]: "names step 51 and its checksum among the structural steps",
    [MAPPING_ACTS]: "registers the step-51 project-mapping act domain in the upgrade's registry", [GRANTS_STEP]: "names step 52 and its checksum among the structural steps",
    [AUTHORITY_ACTS]: "registers the step-52 authority act domain in the upgrade's registry, after the mapping domain" },
  [MAPPING_ACTS]: { [MAPPING_STEP]: "passes the step-51 gate with the step's version before reading the mapping columns",
    [STORED_TEXT]: "refuses every identifier it compares or an act writes back whose stored bytes do not read back exactly" },
  [AUTHORITY_ACTS]: { [GRANTS_STEP]: "passes the step-52 gate with the step's version before reading or writing the grants table",
    [AUTHORITY_RESET]: "runs the quarantine's reset statements as the upgrade's revoke and release acts",
    [RECOVERY_PREDICTION]: "refuses what the test-run recovery could fail on and checks the recovery's outcome against its prediction",
    [STORED_TEXT]: "refuses every principal ID whose stored bytes do not read back exactly, the owner's being written into the grant" },
  [RECOVERY_PREDICTION]: { [STORED_TEXT]: "refuses every identifier and ordered text it reads whose stored bytes do not read back exactly" },
  [`${SQLITE}/database-validation.ts`]: { [MAPPING_STEP]: "validates the step-51 clock, stamps, parents and journal at version 51",
    [GRANTS_STEP]: "validates the shape of the step-52 grants at version 52" },
  [`${SQLITE}/security-maintenance.ts`]: { [MAPPING_STEP]: "plans and applies the step-51 mapping quarantine at target 51",
    [GRANTS_STEP]: "deletes every step-52 grant in the quarantine at target 52", [AUTHORITY_RESET]: "runs the reset statements it shares with the upgrade, in the quarantine's order, at every target" },
  [DIRECTORY]: { [MAPPING_STEP]: "passes the step-51 gate with the step's version" },
  [GRANTS_READER]: { [GRANTS_STEP]: "passes the step-52 gate with the step's version before reading the grants table" },
});

const MARKER_TEXT = "account_grants";
/** The only non-test files that may contain the text `account_grants`, each with its reason. */
const GRANTS_TEXT_FILES: Readonly<Record<string, string>> = Object.freeze({
  [`${SQLITE}/account-grants-migration.ts`]: "defines step 52's table, its validation and the quarantine's deletion",
  [`${SQLITE}/authority-upgrade-acts.ts`]: "writes the first admin grant in the upgrade's authority acts",
  [`${SQLITE}/schema-inspection.ts`]: "recognises the table's structure from the catalogue, never its rows",
  [`${SQLITE}/fixtures/schema-rewind.ts`]: "rewinds synthetic step-52 test fixtures",
  // The read side of the operations module's unmounted grants adapter. Rule 1 confines its importer to the store.
  [GRANTS_READER]: "reads one account and its stored grants through the store's structural read port",
});
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
/** An emitted-style specifier (`./x.js`) that TypeScript resolves to its source. */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const repository = resolve(".");

/** `star`: an `export *` or `export * as` re-export, which carries every export of its module without naming one. */
interface ModuleImport { specifier: string; form: string; line: number; star: boolean }
/** Where an entry point's name is written; see {@link nameContext}. */
interface NameOccurrence { name: string; context: string; line: number }

/**
 * Every literal module specifier of a source text, with its form; `names`, when
 * given, also collects each identifier or string literal that is exactly one of
 * the guarded entry points (ENTRY_NAMES), with its context.
 */
function moduleImports(fileName: string, text: string, names?: NameOccurrence[]): ModuleImport[] {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: ModuleImport[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, form: "import", line: line(node), star: false });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const star = !node.exportClause || ts.isNamespaceExport(node.exportClause);
      found.push({ specifier: node.moduleSpecifier.text, form: "re-export", line: line(node), star });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, form: "import = require()", line: line(node), star: false });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, form: "import() type", line: line(node), star: false });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression, first = node.arguments[0];
      const form = callee.kind === ts.SyntaxKind.ImportKeyword ? "import()" : ts.isIdentifier(callee) && callee.text === "require" ? "require()" : undefined;
      if (form && first && ts.isStringLiteralLike(first)) found.push({ specifier: first.text, form, line: line(node), star: false });
    }
    if (names && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && ENTRY_NAMES.has(node.text)) {
      names.push({ name: node.text, context: nameContext(source, node), line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function realOrSelf(path: string): string { try { return realpathSync(path); } catch { return path; } }

/*
 * Disk lookups, each made once per path. The scan resolves every one of a few
 * thousand imports against every step module; uncached, that repeated
 * the same existence and real-path checks for each module (over half a million
 * calls, most of the scan's time). Neither the repository nor any path a fixture
 * names under it changes while this file runs, so a cached answer is the answer.
 */
const existingReals = new Map<string, ReadonlySet<string>>(), targetReals = new Map<string, string>();
/** The real path of every file that `base` names on disk, as written or with its script extension swapped, under each resolved extension. */
function realsOnDisk(base: string): ReadonlySet<string> {
  let reals = existingReals.get(base);
  if (!reals) {
    reals = new Set([base, base.replace(SCRIPT_EXTENSION, "")].flatMap(candidate => RESOLVE_EXTENSIONS.map(extension => candidate + extension))
      .filter(path => existsSync(path)).map(realOrSelf));
    existingReals.set(base, reals);
  }
  return reals;
}
function targetReal(target: string): string {
  let real = targetReals.get(target);
  if (real === undefined) { real = realOrSelf(join(repository, target)); targetReals.set(target, real); }
  return real;
}

/** Whether a literal specifier written in `fromFile` (repository-relative) resolves to `target` (repository-relative). */
function reaches(fromFile: string, specifier: string, target: string): boolean {
  let base: string;
  if (specifier.startsWith("file:")) { try { base = fileURLToPath(specifier); } catch { return false; } }
  else if (specifier === "@" || specifier.startsWith("@/")) base = join(repository, "src", specifier.slice(2));
  else if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) base = resolve(repository, dirname(fromFile), specifier);
  else if (isAbsolute(specifier)) base = resolve(specifier);
  else return false;
  // Lexically, as written (this also covers in-memory fixtures), then by real path on disk.
  const name = relative(repository, base).split(sep).join(posix.sep);
  const targetBase = target.replace(SCRIPT_EXTENSION, "");
  if (name === target || name.replace(SCRIPT_EXTENSION, "") === targetBase) return true;
  return realsOnDisk(base).has(targetReal(target));
}

/** Imports of a step module, each with the module it resolves to. */
function stepImportEntries(fileName: string, text: string, imports = moduleImports(fileName, text)): Array<ModuleImport & { module: string }> {
  return imports.flatMap(entry => STEP_MODULES.filter(step => reaches(fileName, entry.specifier, step)).map(module => ({ ...entry, module })));
}
/** Imports of a step module. */
function stepImports(fileName: string, text: string): string[] {
  return stepImportEntries(fileName, text).map(entry => `${entry.form} of ${entry.specifier} at line ${entry.line}`);
}
/** Imports of a step module that STEP_IMPORTS does not permit for this importer. */
function stepFindings(fileName: string, text: string, entries = stepImportEntries(fileName, text)): string[] {
  return entries.filter(entry => !Object.hasOwn(STEP_IMPORTS[fileName] ?? {}, entry.module))
    .map(entry => `${entry.form} of ${entry.specifier} (${entry.module}) at line ${entry.line}`);
}

function sources(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) files.push(path);
    }
  };
  walk(join(repository, "src"));
  return files.map(file => relative(repository, file).split(sep).join("/")).sort();
}

interface ScannedSource { file: string; text: string; imports: ModuleImport[]; steps: Array<ModuleImport & { module: string }>; names: readonly NameOccurrence[] }
let scanned: ScannedSource[] | undefined;
/** Every non-test source file under `src/`, read and parsed once for every rule of this file. */
function scan(): ScannedSource[] {
  scanned ??= sources().map(file => {
    const text = readFileSync(join(repository, file), "utf8"), names: NameOccurrence[] = [], imports = moduleImports(file, text, names);
    return { file, text, imports, steps: stepImportEntries(file, text, imports), names };
  });
  return scanned;
}


/*
 * Rule 3: the mounted entry points of the upgrade, the establishment with a
 * backup and the ordinary admission.
 */
const UPGRADE_COMPOSITION = "src/server/bootstrap/upgrade-maintenance.ts", UPGRADE_RUNNER = "src/cli/upgrade.ts", CLI_ENTRY = "src/cli/index.ts";
const BOOTSTRAP_FENCE = "src/server/bootstrap/security-maintenance.ts", FENCE_COMMAND = "src/cli/security-fence.ts";
const PROTECTED_FIXTURE = `${SQLITE}/fixtures/protected-security.ts`;
const SQLITE_FENCE = `${SQLITE}/security-maintenance.ts`, SQLITE_UPGRADE = `${SQLITE}/upgrade-maintenance.ts`, SQLITE_API = `${SQLITE}/index.ts`;
const SQLITE_ADMISSION = `${SQLITE}/ordinary-admission.ts`, OWNED = `${SQLITE}/owned-database.ts`;
/** The only importers of the upgrade's composition and its runner. */
const MOUNTED_IMPORTERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [UPGRADE_COMPOSITION]: [UPGRADE_RUNNER, PROTECTED_FIXTURE],
  [UPGRADE_RUNNER]: [CLI_ENTRY],
});
/**
 * The only places a non-test file may write each entry point: file, then the
 * contexts allowed there (see {@link nameContext}). Every pair is one the tree
 * uses today.
 */
const ENTRY_OCCURRENCES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  establishSecurityFenceWithBackup: { [BOOTSTRAP_FENCE]: ["declaration"], [FENCE_COMMAND]: ["import", "body of runSecurityFenceCommand"],
    [PROTECTED_FIXTURE]: ["import", "body of openProtectedUpgradeFixture"] },
  establishSqliteSecurityFence: { [SQLITE_FENCE]: ["declaration"], [SQLITE_API]: ["re-export"], [BOOTSTRAP_FENCE]: ["import", "body of establishSecurityFenceWithBackup"] },
  inspectSqliteUpgrade: { [SQLITE_UPGRADE]: ["declaration"], [SQLITE_API]: ["re-export"], [UPGRADE_COMPOSITION]: ["import", "body of inspectUpgrade"] },
  applySqliteUpgrade: { [SQLITE_UPGRADE]: ["declaration"], [SQLITE_API]: ["re-export"], [UPGRADE_COMPOSITION]: ["import", "body of applyUpgrade"] },
  runUpgradeCommand: { [UPGRADE_RUNNER]: ["declaration"], [CLI_ENTRY]: ["import", "body of main"] },
  assertOrdinaryAdmission: { [SQLITE_ADMISSION]: ["declaration"], [OWNED]: ["import", "body of OwnedSqliteDatabase.constructor"] },
});
const ENTRY_NAMES: ReadonlySet<string> = new Set(Object.keys(ENTRY_OCCURRENCES));
/** Modules that define or re-export an entry point: an `export *` of one would carry it without naming it. */
const ENTRY_CARRIERS = Object.freeze([BOOTSTRAP_FENCE, SQLITE_FENCE, SQLITE_UPGRADE, SQLITE_API, SQLITE_ADMISSION, UPGRADE_RUNNER]);
/**
 * The context of a name: `string literal`; `import` or `aliased import` (an
 * import specifier with `as`); `re-export`, `aliased export` or `local export`
 * (an export specifier with a module, with `as`, or without a module);
 * `declaration` (the name of a top-level function declaration); `body of F`
 * (anywhere inside the body of the top-level function declaration F, nested
 * functions included); `signature of F`; `body of C.m` (inside member `m` of
 * the top-level class C, `constructor` for its constructor); otherwise
 * `module level`.
 */
function nameContext(source: ts.SourceFile, node: ts.Identifier | ts.StringLiteralLike): string {
  if (ts.isStringLiteralLike(node)) return "string literal";
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return parent.propertyName ? "aliased import" : "import";
  if (ts.isExportSpecifier(parent)) return parent.propertyName ? "aliased export" : parent.parent.parent.moduleSpecifier ? "re-export" : "local export";
  if (ts.isFunctionDeclaration(parent) && parent.name === node && parent.parent === source) return "declaration";
  let top: ts.Node = node;
  while (top.parent && top.parent !== source) top = top.parent;
  if (ts.isFunctionDeclaration(top) && top.name) {
    return top.body && node.pos >= top.body.pos && node.end <= top.body.end ? `body of ${top.name.text}` : `signature of ${top.name.text}`;
  }
  if (ts.isClassDeclaration(top) && top.name) {
    let member: ts.Node = node;
    while (member.parent && member.parent !== top) member = member.parent;
    if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) {
      const name = ts.isConstructorDeclaration(member) ? "constructor" : member.name.getText(source);
      return member.body && node.pos >= member.body.pos && node.end <= member.body.end ? `body of ${top.name.text}.${name}` : `signature of ${top.name.text}.${name}`;
    }
  }
  return "module level";
}
/** Imports of the upgrade's composition or runner that MOUNTED_IMPORTERS does not permit. */
function mountedImportFindings(fileName: string, imports: readonly ModuleImport[]): string[] {
  return imports.flatMap(entry => Object.entries(MOUNTED_IMPORTERS).filter(([module, importers]) => !importers.includes(fileName) && reaches(fileName, entry.specifier, module))
    .map(([module]) => `${entry.form} of ${entry.specifier} (${module}) at line ${entry.line}`));
}
/** Entry points written where ENTRY_OCCURRENCES does not allow, and `export *` of a module that carries one. */
function entryNameFindings(fileName: string, names: readonly NameOccurrence[], imports: readonly ModuleImport[]): string[] {
  return [
    ...names.filter(entry => !(ENTRY_OCCURRENCES[entry.name]?.[fileName] ?? []).includes(entry.context)).map(entry => `${entry.name} (${entry.context}) at line ${entry.line}`),
    ...imports.filter(entry => entry.star).flatMap(entry => ENTRY_CARRIERS.filter(module => reaches(fileName, entry.specifier, module))
      .map(module => `export * of ${entry.specifier} (${module}) at line ${entry.line}`)),
  ];
}

/*
 * Rule 4: every opening of the database, classified. `ordinary` openings pass
 * the admission check (the store, which constructs its own ordinary owner, and
 * the read-only remote recovery inspection); `maintenance` openings must keep
 * working on a database that needs the upgrade (fence maintenance, the
 * upgrade, whole-installation backup creation, snapshot verification and
 * restore); `ownership` is the owner's own machinery; `test support` is a
 * fixture under `src/`. The key is file, kind, context and the argument text
 * without whitespace.
 */
type OpeningKind = "SqliteStateStore" | "OwnedSqliteDatabase" | "better-sqlite3" | "acquireDatabaseOwnership";
type OpeningClass = "ordinary" | "maintenance" | "ownership" | "test support";
interface Opening { file: string; kind: OpeningKind; context: string; args: string }
const OPENINGS: ReadonlyArray<Opening & { class: OpeningClass; why: string }> = Object.freeze([
  { file: "src/cli/auth-management.ts", kind: "SqliteStateStore", context: "body of runAuthCommand", args: "paths.databasePath", class: "ordinary", why: "auth status, token and mode" },
  { file: "src/cli/auth-management.ts", kind: "SqliteStateStore", context: "body of runProviderCommand", args: "paths.databasePath", class: "ordinary", why: "auth provider administration" },
  { file: "src/cli/backup-management.ts", kind: "OwnedSqliteDatabase", context: "body of runBackupCommand", args: "paths.databasePath", class: "maintenance", why: "offline whole-installation backup create" },
  { file: "src/cli/backup-management.ts", kind: "SqliteStateStore", context: "body of runBackupCommand", args: "paths.databasePath", class: "ordinary", why: "project export and import" },
  { file: "src/cli/identity-management.ts", kind: "SqliteStateStore", context: "body of runIdentityCommand", args: "paths.databasePath", class: "ordinary", why: "identity" },
  { file: "src/cli/knowledge-management.ts", kind: "SqliteStateStore", context: "body of runHubImportExecuteCommand", args: "paths.databasePath", class: "ordinary", why: "knowledge execute-import" },
  { file: "src/cli/mcp-config.ts", kind: "SqliteStateStore", context: "body of currentMode", args: "paths.databasePath", class: "ordinary", why: "config mcp of a stopped controller" },
  { file: "src/cli/project-management.ts", kind: "SqliteStateStore", context: "body of openProjectGateway", args: "paths.databasePath", class: "ordinary", why: "project and doctor, offline" },
  { file: "src/cli/remote-verification.ts", kind: "SqliteStateStore", context: "body of runRemoteVerificationCommand", args: "paths.databasePath", class: "ordinary", why: "remote reconcile" },
  { file: "src/cli/remote-verification.ts", kind: "SqliteStateStore", context: "body of runRemoteVerificationCommand", args: "paths.databasePath", class: "ordinary", why: "remote provision and revoke-token" },
  { file: "src/cli/sandbox.ts", kind: "SqliteStateStore", context: "body of prepareSandboxInstallation", args: "paths.databasePath", class: "ordinary", why: "the sandbox's fresh store" },
  { file: "src/cli/session-describe.ts", kind: "SqliteStateStore", context: "body of runLockFirstRead", args: "paths.databasePath", class: "ordinary", why: "lock-first offline session description and project reads after restore-handoff admission" },
  { file: "src/server/controller-backup.ts", kind: "better-sqlite3", context: "body of createControllerBackup", args: "databaseFile,{fileMustExist:true}", class: "maintenance", why: "the backup's own snapshot copy" },
  { file: "src/server/controller-backup.ts", kind: "acquireDatabaseOwnership", context: "body of restoreControllerBackup", args: "databasePath", class: "maintenance", why: "offline restore" },
  { file: "src/server/controller-storage.ts", kind: "SqliteStateStore", context: "body of openControllerStore", args: "databasePath", class: "ordinary", why: "controller start" },
  { file: "src/server/controller-storage.ts", kind: "SqliteStateStore", context: "body of openCurrentControllerStore", args: "databasePath", class: "ordinary", why: "service install's pre-bootstrap" },
  { file: `${SQLITE}/backup-binding.ts`, kind: "better-sqlite3", context: "body of takeBoundBackup", args: "file,{readonly:true,fileMustExist:true}", class: "maintenance", why: "reads the maintenance backup's copy" },
  { file: `${SQLITE}/backup-validation.ts`, kind: "better-sqlite3", context: "body of validateSnapshot", args: "path,{readonly:true,fileMustExist:true}", class: "maintenance", why: "snapshot verification" },
  { file: `${SQLITE}/backup-validation.ts`, kind: "better-sqlite3", context: "body of stageVerifiedBackup", args: "path,{fileMustExist:true}", class: "maintenance", why: "restore staging" },
  { file: OWNED, kind: "better-sqlite3", context: "body of closeUnverified", args: "path,{readonly:true,fileMustExist:true}", class: "ownership", why: "shields of the verified writable transition" },
  { file: OWNED, kind: "acquireDatabaseOwnership", context: "body of OwnedSqliteDatabase.constructor", args: "path,{inspectOnly:true}", class: "ownership", why: "inspection-only ownership" },
  { file: OWNED, kind: "acquireDatabaseOwnership", context: "body of OwnedSqliteDatabase.constructor", args: "path", class: "ownership", why: "ordinary ownership" },
  { file: OWNED, kind: "better-sqlite3", context: "body of OwnedSqliteDatabase.constructor", args: "this.ownership.path,{readonly:true,fileMustExist:true}", class: "ownership", why: "the read-only inspection connection, where the admission runs" },
  { file: OWNED, kind: "better-sqlite3", context: "body of OwnedSqliteDatabase.enableWrites", args: "this.ownership.path,{fileMustExist:true}", class: "ownership", why: "writable reopen after the inspection" },
  { file: OWNED, kind: "better-sqlite3", context: "body of OwnedSqliteDatabase.enableVerifiedWrites", args: "path,{readonly:true,fileMustExist:true}", class: "ownership", why: "the guard of the verified writable transition" },
  { file: OWNED, kind: "better-sqlite3", context: "body of OwnedSqliteDatabase.enableVerifiedWrites", args: "path,{fileMustExist:true}", class: "ownership", why: "the verified writable reopen" },
  { file: `${SQLITE}/remote-connection-inspection.ts`, kind: "OwnedSqliteDatabase", context: "body of openRemoteRecoveryInspection", args: "path,false,undefined,{inspectOnly:true,ordinary:true}", class: "ordinary", why: "the read-only remote recovery inspection" },
  { file: `${SQLITE}/schema-inspection.ts`, kind: "better-sqlite3", context: "body of knownStructure", args: "\":memory:\"", class: "ownership", why: "the in-memory reference schema, no file" },
  { file: SQLITE_FENCE, kind: "OwnedSqliteDatabase", context: "body of maintenance", args: "paths.databasePath,false,version", class: "maintenance", why: "auth fence inspect, establish and resume" },
  { file: `${SQLITE}/sqlite-state-store.ts`, kind: "OwnedSqliteDatabase", context: "body of SqliteStateStore.constructor", args: "databasePath,true,undefined,{ordinary:true}", class: "ordinary", why: "the store's own owner" },
  { file: SQLITE_UPGRADE, kind: "OwnedSqliteDatabase", context: "body of ownership", args: "paths.databasePath,false,target,{inspectOnly:true}", class: "maintenance", why: "upgrade inspect and apply" },
  { file: "src/server/modules/backups/remote-rebind.ts", kind: "acquireDatabaseOwnership", context: "body of rebindRemoteBackup", args: "input.databasePath,{inspectOnly:true,inspect}", class: "maintenance", why: "remote rebind, which opens no SQLite connection" },
  { file: "src/server/restore-requests.ts", kind: "acquireDatabaseOwnership", context: "body of executeControllerRestoreRequest", args: "databasePath", class: "maintenance", why: "restore execution" },
  { file: `${SQLITE}/fixtures/attachment-crash-worker.ts`, kind: "OwnedSqliteDatabase", context: "module level", args: "database,true,undefined,{ordinary:true}", class: "test support", why: "crash worker" },
  { file: `${SQLITE}/fixtures/attachment-crash-worker.ts`, kind: "SqliteStateStore", context: "module level", args: "database,owned", class: "test support", why: "crash worker" },
  { file: `${SQLITE}/fixtures/initialization-crash-worker.ts`, kind: "OwnedSqliteDatabase", context: "module level", args: "process.argv[2],true", class: "test support", why: "interrupted creation" },
  { file: `${SQLITE}/fixtures/ownership-worker.ts`, kind: "OwnedSqliteDatabase", context: "module level", args: "process.argv[2]!", class: "test support", why: "ownership worker" },
  { file: `${SQLITE}/fixtures/released-schema.ts`, kind: "OwnedSqliteDatabase", context: "body of createFencedDatabase", args: "databasePath,true,target,{ordinary:true}", class: "test support", why: "versioned fixture creation" },
  { file: `${SQLITE}/fixtures/released-schema.ts`, kind: "SqliteStateStore", context: "body of openStoreAt", args: "databasePath,newOwnedSqliteDatabase(databasePath,false,target,{ordinary:true})", class: "test support", why: "the test-side store at an explicit target" },
  { file: `${SQLITE}/fixtures/released-schema.ts`, kind: "OwnedSqliteDatabase", context: "body of openStoreAt", args: "databasePath,false,target,{ordinary:true}", class: "test support", why: "the test-side store at an explicit target" },
  { file: `${SQLITE}/fixtures/restore-crash-worker.ts`, kind: "OwnedSqliteDatabase", context: "module level", args: "database", class: "test support", why: "restore crash worker" },
  { file: `${SQLITE}/fixtures/security-fence-child.ts`, kind: "SqliteStateStore", context: "module level", args: "path!", class: "test support", why: "fence crash child" },
  { file: "src/server/modules/backups/fixtures/handoff-crash-worker.ts", kind: "SqliteStateStore", context: "module level", args: "database", class: "test support", why: "handoff crash worker" },
  { file: "src/server/modules/dev-vault/test-fixture.ts", kind: "SqliteStateStore", context: "body of vaultFixture", args: "path", class: "test support", why: "vault fixture" },
  { file: "src/server/modules/dev-vault/test-fixture.ts", kind: "SqliteStateStore", context: "body of vaultFixture", args: "path", class: "test support", why: "vault fixture, reopened" },
  { file: "src/server/modules/remote-verification/fixtures/remote-worker-process.ts", kind: "SqliteStateStore", context: "module level", args: "databasePath", class: "test support", why: "remote worker process" },
  { file: "src/server/modules/status/scoped-diagnostics-fixture.ts", kind: "SqliteStateStore", context: "body of diagnosticsFixture", args: "join(root,\"state.sqlite3\")", class: "test support", why: "diagnostics fixture" },
  { file: "src/server/unmanaged-sqlite-fixture.ts", kind: "better-sqlite3", context: "body of unmanagedFixtureDatabase", args: "filename,options", class: "test support", why: "unmanaged fixture connections" },
]);
const openingKey = (opening: Opening) => `${opening.file} | ${opening.kind} | ${opening.context} | ${opening.args}`;
/**
 * Every opening of a source text: `new SqliteStateStore(...)`,
 * `new OwnedSqliteDatabase(...)`, `new X(...)` or `X(...)` where X is the
 * file's value import of `better-sqlite3`, and `acquireDatabaseOwnership(...)`.
 */
function openings(fileName: string, text: string): Opening[] {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const drivers = new Set<string>(), found: Opening[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text === "better-sqlite3"
      && statement.importClause?.name && !statement.importClause.isTypeOnly) drivers.add(statement.importClause.name.text);
  }
  const context = (node: ts.Node) => nodeContext(source, node);
  const args = (list: ts.NodeArray<ts.Expression> | undefined) => (list ?? []).map(argument => argument.getText(source)).join(",").replace(/\s+/g, "");
  const visit = (node: ts.Node) => {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const kindOf: OpeningKind | undefined = ts.isNewExpression(node) && (name === "SqliteStateStore" || name === "OwnedSqliteDatabase") ? name
        : drivers.has(name) ? "better-sqlite3" : ts.isCallExpression(node) && name === "acquireDatabaseOwnership" ? "acquireDatabaseOwnership" : undefined;
      if (kindOf) found.push({ file: fileName, kind: kindOf, context: context(node), args: args(node.arguments) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
/** The context of any node, as {@link nameContext} gives it for a name that is not an import, export or declaration. */
function nodeContext(source: ts.SourceFile, node: ts.Node): string {
  let top: ts.Node = node;
  while (top.parent && top.parent !== source) top = top.parent;
  if (ts.isFunctionDeclaration(top) && top.name) return top.body && node.pos >= top.body.pos && node.end <= top.body.end ? `body of ${top.name.text}` : `signature of ${top.name.text}`;
  if (ts.isClassDeclaration(top) && top.name) {
    let member: ts.Node = node;
    while (member.parent && member.parent !== top) member = member.parent;
    if (ts.isConstructorDeclaration(member)) return `body of ${top.name.text}.constructor`;
    if (ts.isMethodDeclaration(member)) return `body of ${top.name.text}.${member.name.getText(source)}`;
  }
  return "module level";
}

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const UNSUPPORTED = "Unsupported schema target.";
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
const HANDOFF = { preflight: () => undefined, acknowledge: () => undefined };
const UNUSED_BACKUP = async (): Promise<never> => { throw new Error("fixture backup must not run"); };

describe("schema entry points", () => {
  it("supports 53, keeps the fence base at 49 and refuses 54 at every public entry point, before any lock or file", async () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(53);
    expect(SECURITY_FENCE_SCHEMA_VERSION).toBe(49);
    expect(schemaTarget()).toBe(53);
    const root = mkdtempSync(join(tmpdir(), "schema-entry-")); temporary.push(root);
    const paths = resolveAppPaths(join(root, "data"));
    const memory = new Database(":memory:");
    try {
      const refusals = {
        schemaTarget: () => schemaTarget(54),
        initializeSchema: () => initializeSchema(memory, undefined, undefined, { target: 54 }),
        inspectSchema: () => inspectSchema(memory, 54),
        OwnedSqliteDatabase: () => new OwnedSqliteDatabase(paths.databasePath, true, 54),
        maintainSqliteSecurityFence: () => maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, 54),
        quarantineAuthority: () => quarantineAuthority(memory, "receipt", "token", 54),
        parseManifest: () => parseManifest({}, 54),
        upgradeTarget: () => upgradeTarget(54),
        inspectSqliteUpgrade: () => inspectSqliteUpgrade(paths, 54),
        applySqliteUpgrade: () => applySqliteUpgrade(paths, { expect: "0".repeat(64) }, UNUSED_BACKUP, 54),
        establishSqliteSecurityFence: () => establishSqliteSecurityFence(paths, { action: "establish", expect: "0".repeat(64) }, HANDOFF, UNUSED_BACKUP, 54),
      };
      for (const [entry, refusal] of Object.entries(refusals)) expect(message(refusal), entry).toBe(UNSUPPORTED);
      expect(memory.prepare("SELECT count(*) FROM sqlite_master").pluck().get()).toBe(0);
      // Nothing was created: no data or state directory, no lock.
      expect(existsSync(paths.dataDirectory)).toBe(false);
      expect(existsSync(paths.stateDirectory)).toBe(false);
    } finally { memory.close(); }
  });

  it("finds no step-module import outside its listed pairs; only the store imports the directory and grants reader", () => {
    const scanned = scan();
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.flatMap(({ file, text, steps }) => stepFindings(file, text, steps).map(finding => `${file}: ${finding}`))).toEqual([]);
    for (const stepModule of [DIRECTORY, GRANTS_READER]) {
      expect(Object.keys(STEP_IMPORTS).filter(file => Object.hasOwn(STEP_IMPORTS[file], stepModule))).toEqual([STORE]);
      expect(scanned.filter(({ steps }) => steps.some(entry => entry.module === stepModule)).map(({ file }) => file)).toEqual([STORE]);
    }
  }, 30_000); // One parse of every source file under src/: about a second here, growing with the tree.

  it("keeps the new grants table out of every file but its step, the authority acts, the schema recognition, the rewind fixture and the unmounted reader", () => {
    const found = scan().filter(({ text }) => text.includes(MARKER_TEXT)).map(({ file }) => file).sort();
    expect(found).toEqual(Object.keys(GRANTS_TEXT_FILES).sort());
    for (const reason of Object.values(GRANTS_TEXT_FILES)) expect(reason.length).toBeGreaterThan(10);
  }, 30_000);

  it("mounts the upgrade, the establishment with a backup and the admission only where they belong", () => {
    const scanned = scan();
    for (const file of [UPGRADE_COMPOSITION, UPGRADE_RUNNER, BOOTSTRAP_FENCE, CLI_ENTRY, FENCE_COMMAND, OWNED]) expect(scanned.map(({ file: name }) => name), file).toContain(file);
    expect(scanned.flatMap(({ file, imports }) => mountedImportFindings(file, imports).map(finding => `${file}: ${finding}`))).toEqual([]);
    expect(scanned.flatMap(({ file, names, imports }) => entryNameFindings(file, names, imports).map(finding => `${file}: ${finding}`))).toEqual([]);
    // Each allowed place is used today.
    for (const [name, files] of Object.entries(ENTRY_OCCURRENCES)) {
      for (const [file, contexts] of Object.entries(files)) {
        for (const context of contexts) expect(scanned.find(entry => entry.file === file)?.names.some(entry => entry.name === name && entry.context === context), `${file} → ${name} (${context})`).toBe(true);
      }
    }
    for (const [module, importers] of Object.entries(MOUNTED_IMPORTERS)) {
      for (const importer of importers) expect(scanned.find(({ file }) => file === importer)!.imports.some(entry => reaches(importer, entry.specifier, module)), `${importer} → ${module}`).toBe(true);
    }
  }, 30_000);

  it("classifies every opening of the database, and admits only through ordinary owners at the default ceiling", () => {
    const found = scan().flatMap(({ file, text }) => openings(file, text)).map(openingKey).sort();
    expect(found).toEqual(OPENINGS.map(openingKey).sort());
    const production = OPENINGS.filter(opening => opening.class !== "test support");
    for (const opening of production) {
      expect(opening.why.length, openingKey(opening)).toBeGreaterThan(3);
      // A production store constructs its own ordinary owner; it is never handed one.
      if (opening.kind === "SqliteStateStore") expect(opening.args.split(","), openingKey(opening)).toHaveLength(1);
      // Ordinary owners pass `ordinary` at the default ceiling; no other production owner passes it.
      if (opening.kind === "OwnedSqliteDatabase") {
        expect(opening.args.includes("ordinary:true"), openingKey(opening)).toBe(opening.class === "ordinary");
        if (opening.class === "ordinary") expect(opening.args.split(",")[2], openingKey(opening)).toBe("undefined");
      }
    }
  }, 30_000);

  it("reports every literal import of the mounted modules outside their importers, and every name of the entry points outside their places", () => {
    const strip = (findings: string[]) => findings.map(entry => entry.replace(/ at line \d+$/, ""));
    const imports = (file: string, text: string) => strip(mountedImportFindings(file, moduleImports(file, text)));
    // The runner and the composition, imported anywhere else.
    for (const file of [BOOTSTRAP_FENCE, FENCE_COMMAND, "src/server/controller.ts", "src/cli/auth-management.ts"]) {
      expect(imports(file, 'import { runUpgradeCommand } from "@/cli/upgrade";'), file).toEqual([`import of @/cli/upgrade (${UPGRADE_RUNNER})`]);
      expect(imports(file, 'import { inspectUpgrade } from "@/server/bootstrap/upgrade-maintenance";'), file).toEqual([`import of @/server/bootstrap/upgrade-maintenance (${UPGRADE_COMPOSITION})`]);
    }
    expect(imports(CLI_ENTRY, 'import { runUpgradeCommand } from "./upgrade"; const lazy = import("./upgrade.js");')).toEqual([]);
    expect(imports(CLI_ENTRY, 'import { applyUpgrade } from "../server/bootstrap/upgrade-maintenance";')).toEqual([`import of ../server/bootstrap/upgrade-maintenance (${UPGRADE_COMPOSITION})`]);
    expect(imports(UPGRADE_RUNNER, 'import { applyUpgrade } from "../server/bootstrap/upgrade-maintenance";')).toEqual([]);
    const names = (file: string, text: string | string[]) => {
      const found: NameOccurrence[] = [], source = Array.isArray(text) ? text.join("\n") : text;
      return strip(entryNameFindings(file, found, moduleImports(file, source, found)));
    };
    // The admission check: in the owner's constructor only; never in the store, controller storage, inspection or ownership helpers.
    const store = `${SQLITE}/sqlite-state-store.ts`;
    expect(names(store, ['import { assertOrdinaryAdmission } from "./ordinary-admission";',
      "export class SqliteStateStore { constructor() { assertOrdinaryAdmission(owner); } }"]))
      .toEqual(["assertOrdinaryAdmission (import)", "assertOrdinaryAdmission (body of SqliteStateStore.constructor)"]);
    expect(names("src/server/controller-storage.ts", "export function openControllerStore(owner: Owner) { return assertOrdinaryAdmission(owner); }"))
      .toEqual(["assertOrdinaryAdmission (body of openControllerStore)"]);
    expect(names(OWNED, ['import { assertOrdinaryAdmission } from "./ordinary-admission";',
      "export class OwnedSqliteDatabase { constructor() { assertOrdinaryAdmission(this); } enableWrites() { assertOrdinaryAdmission(this); } }",
      "export function acquireDatabaseOwnership() { assertOrdinaryAdmission(owner); }"]))
      .toEqual(["assertOrdinaryAdmission (body of OwnedSqliteDatabase.enableWrites)", "assertOrdinaryAdmission (body of acquireDatabaseOwnership)"]);
    expect(names(SQLITE_API, ['export { assertOrdinaryAdmission } from "./ordinary-admission";', 'export * from "./ordinary-admission";']))
      .toEqual(["assertOrdinaryAdmission (re-export)", `export * of ./ordinary-admission (${SQLITE_ADMISSION})`]);
    // The establishment with a backup: from the fence command's runner only; the released facade must not reach it.
    expect(names(FENCE_COMMAND, ['import { establishSecurityFenceWithBackup, maintainSecurityFence } from "../server/bootstrap/security-maintenance";',
      "export async function runSecurityFenceCommand() { return establishSecurityFenceWithBackup(paths, command, backup); }"])).toEqual([]);
    expect(names(FENCE_COMMAND, "export function other() { return establishSecurityFenceWithBackup(paths, command, backup); }"))
      .toEqual(["establishSecurityFenceWithBackup (body of other)"]);
    expect(names(BOOTSTRAP_FENCE, "export function maintainSecurityFence(paths: AppPaths, command: Command) { return establishSqliteSecurityFence(paths, command, HANDOFF, backup); }"))
      .toEqual(["establishSqliteSecurityFence (body of maintainSecurityFence)"]);
    // The upgrade runner: from the CLI entry's main only.
    expect(names(CLI_ENTRY, ['import { runUpgradeCommand } from "./upgrade";', "async function main() { await runUpgradeCommand(args, paths, write, options); }"])).toEqual([]);
    expect(names(CLI_ENTRY, "async function handleServiceCommand() { await runUpgradeCommand(args, paths, write, options); }"))
      .toEqual(["runUpgradeCommand (body of handleServiceCommand)"]);
    // A string of the same text is refused, and so is an `export *` of a carrier.
    expect(names("src/server/example.ts", 'const text = "assertOrdinaryAdmission";')).toEqual(["assertOrdinaryAdmission (string literal)"]);
    expect(names("src/server/example.ts", ['export * from "@/server/infrastructure/sqlite";', 'export * from "./modules/status";']))
      .toEqual([`export * of @/server/infrastructure/sqlite (${SQLITE_API})`]);
  });

  it("reports every opening form, so that a new one cannot pass unclassified", () => {
    const keys = (file: string, text: string) => openings(file, text).map(opening => `${opening.kind} | ${opening.context} | ${opening.args}`);
    expect(keys("src/cli/example.ts", [
      'import Driver from "better-sqlite3";',
      'import type Typed from "better-sqlite3";',
      "export function open(path: string) { const store = new SqliteStateStore(path); const owner = new OwnedSqliteDatabase(path, false, 49, { ordinary: true });",
      "  const raw = new Driver(path, { readonly: true }); const called = Driver(path); const ownership = acquireDatabaseOwnership(path); return [store, owner, raw, called, ownership]; }",
      "class Opener { constructor() { new SqliteStateStore(path); } reopen() { return new Driver(path); } }",
      "const typed = (x: Typed) => x;",
    ].join("\n"))).toEqual([
      "SqliteStateStore | body of open | path", "OwnedSqliteDatabase | body of open | path,false,49,{ordinary:true}",
      "better-sqlite3 | body of open | path,{readonly:true}", "better-sqlite3 | body of open | path", "acquireDatabaseOwnership | body of open | path",
      "SqliteStateStore | body of Opener.constructor | path", "better-sqlite3 | body of Opener.reopen | path",
    ]);
  });

  it("lists only existing files that need the exception", () => {
    for (const file of [...STEP_MODULES, ...Object.keys(GRANTS_TEXT_FILES), ...Object.keys(MOUNTED_IMPORTERS), ...ENTRY_CARRIERS]) expect(existsSync(join(repository, file)), file).toBe(true);
    for (const [file, modules] of Object.entries(STEP_IMPORTS)) {
      // Each listed pair is one the file actually needs: it imports exactly its listed modules.
      const imported = new Set(stepImportEntries(file, readFileSync(join(repository, file), "utf8")).map(entry => entry.module));
      expect([...imported].sort(), file).toEqual(Object.keys(modules).sort());
      for (const [module, reason] of Object.entries(modules)) {
        expect(STEP_MODULES, `${file} → ${module}`).toContain(module);
        expect(reason.length, `${file} → ${module}`).toBeGreaterThan(10);
      }
    }
  });

  it("reports imports of the step modules by resolved file", () => {
    expect(stepImports("src/server/example.ts", [
      'import { applyUpgradeMarkerMigration as apply } from "./infrastructure/sqlite/upgrade-marker-migration";',
      'export * from "@/server/infrastructure/sqlite/security-coverage";',
      'const lazy = import("./infrastructure/sqlite/upgrade-marker-migration.js");',
      'import { other } from "./upgrade-marker-migration";',
    ].join("\n")).map(entry => entry.replace(/ at line \d+$/, ""))).toEqual([
      "import of ./infrastructure/sqlite/upgrade-marker-migration", "re-export of @/server/infrastructure/sqlite/security-coverage",
      "import() of ./infrastructure/sqlite/upgrade-marker-migration.js",
    ]);
  });

  it("reports a step module an allow-listed importer is not paired with, such as the project directory", () => {
    const strip = (findings: string[]) => findings.map(entry => entry.replace(/ at line \d+$/, ""));
    // database-validation.ts may import the mapping step, not the directory, the marker step or the coverage.
    expect(strip(stepFindings(`${SQLITE}/database-validation.ts`, [
      'import { projectMappingViolation } from "./mapping-structure-migration";',
      'import { ProjectDirectoryQueries } from "./project-directory-queries";',
      'export { ProjectDirectoryQueries as Directory } from "@/server/infrastructure/sqlite/project-directory-queries";',
      'type Directory = typeof import("./project-directory-queries.js");',
      'import { upgradeMarkerMigration } from "./upgrade-marker-migration";',
      'import { SECURITY_COVERAGE } from "./security-coverage";',
    ].join("\n")))).toEqual([
      `import of ./project-directory-queries (${DIRECTORY})`, `re-export of @/server/infrastructure/sqlite/project-directory-queries (${DIRECTORY})`,
      `import() type of ./project-directory-queries.js (${DIRECTORY})`, `import of ./upgrade-marker-migration (${MARKER_STEP})`,
      `import of ./security-coverage (${COVERAGE})`,
    ]);
    // Every other listed importer is reported for the directory, and so is a file that is not listed.
    const specifier = "@/server/infrastructure/sqlite/project-directory-queries";
    for (const file of [...Object.keys(STEP_IMPORTS).filter(file => file !== STORE), `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, `import { ProjectDirectoryQueries } from "${specifier}";`)), file).toEqual([`import of ${specifier} (${DIRECTORY})`]);
    }
    // A listed pair is not a finding.
    expect(stepFindings(`${SQLITE}/security-maintenance.ts`, 'import { applyMappingQuarantine } from "./mapping-structure-migration";')).toEqual([]);
    // The mapping acts (C2b) are importable only by the plan's registry: the maintenance, the mapping step and any other file are reported.
    const actsModule = "@/server/infrastructure/sqlite/mapping-upgrade-acts";
    const acts = `import { MAPPING_ACT_DOMAIN } from "${actsModule}";`;
    expect(stepFindings(`${SQLITE}/upgrade-plan.ts`, acts)).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_STEP, `${SQLITE}/security-maintenance.ts`, "src/server/bootstrap/example.ts"]) {
      expect(strip(stepFindings(file, acts)), file).toEqual([`import of ${actsModule} (${MAPPING_ACTS})`]);
    }
    // So are the authority acts (C3a); the grants step is importable by its listed importers only, never by the maintenance or a module outside this directory.
    const authorityModule = "@/server/infrastructure/sqlite/authority-upgrade-acts", grantsModule = "./account-grants-migration";
    const authority = `import { AUTHORITY_ACT_DOMAIN } from "${authorityModule}";`, grants = `import { clearAccountGrants } from "${grantsModule}";`;
    expect(stepFindings(`${SQLITE}/upgrade-plan.ts`, authority)).toEqual([]);
    expect(stepFindings(`${SQLITE}/security-maintenance.ts`, grants)).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_ACTS, GRANTS_STEP, `${SQLITE}/security-maintenance.ts`, "src/server/bootstrap/example.ts"]) {
      expect(strip(stepFindings(file, authority)), file).toEqual([`import of ${authorityModule} (${AUTHORITY_ACTS})`]);
    }
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_ACTS, `${SQLITE}/sqlite-state-store.ts`]) {
      expect(strip(stepFindings(file, grants)), file).toEqual([`import of ${grantsModule} (${GRANTS_STEP})`]);
    }
    // The shared authority reset: the quarantine and the authority acts only; every other file is reported, in every literal form.
    const resetModule = "./authority-reset";
    const reset = `import { revokeCredentials } from "${resetModule}";`;
    for (const file of [`${SQLITE}/security-maintenance.ts`, AUTHORITY_ACTS]) expect(stepFindings(file, reset), file).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, `${SQLITE}/upgrade-plan.ts`, `${SQLITE}/test-run-queries.ts`, `${SQLITE}/sqlite-state-store.ts`, MAPPING_ACTS, GRANTS_STEP, `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, reset)), file).toEqual([`import of ${resetModule} (${AUTHORITY_RESET})`]);
    }
    expect(strip(stepFindings(`${SQLITE}/upgrade-maintenance.ts`, [
      'export { revokeCredentials as revoke } from "./authority-reset.js";',
      'const lazy = import("@/server/infrastructure/sqlite/authority-reset");',
      'type Reset = typeof import("./authority-reset");',
    ].join("\n")))).toEqual([
      `re-export of ./authority-reset.js (${AUTHORITY_RESET})`, `import() of @/server/infrastructure/sqlite/authority-reset (${AUTHORITY_RESET})`,
      `import() type of ./authority-reset (${AUTHORITY_RESET})`,
    ]);
    expect(strip(stepFindings("src/server/bootstrap/example.ts", 'import { revokeCredentials } from "@/server/infrastructure/sqlite/authority-reset";')))
      .toEqual([`import of @/server/infrastructure/sqlite/authority-reset (${AUTHORITY_RESET})`]);
    // The recovery's predictor: the authority acts only; the recovery itself, the quarantine and every other file are reported.
    const predictionModule = "./test-run-recovery-prediction";
    const prediction = `import { predictRecovery } from "${predictionModule}";`;
    expect(stepFindings(AUTHORITY_ACTS, prediction)).toEqual([]);
    for (const file of [`${SQLITE}/test-run-queries.ts`, `${SQLITE}/test-summary-queries.ts`, AUTHORITY_RESET, `${SQLITE}/security-maintenance.ts`, `${SQLITE}/upgrade-plan.ts`, `${SQLITE}/sqlite-state-store.ts`, `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, prediction)), file).toEqual([`import of ${predictionModule} (${RECOVERY_PREDICTION})`]);
    }
    // The exact-text check: the predictor and both act domains only; the recovery itself, the plan, the maintenance and every other file are reported.
    const textModule = "./stored-text";
    const text = `import { readsBack } from "${textModule}";`;
    for (const file of [RECOVERY_PREDICTION, MAPPING_ACTS, AUTHORITY_ACTS]) expect(stepFindings(file, text), file).toEqual([]);
    for (const file of [`${SQLITE}/test-run-queries.ts`, `${SQLITE}/upgrade-plan.ts`, `${SQLITE}/upgrade-maintenance.ts`, `${SQLITE}/security-maintenance.ts`, `${SQLITE}/database-validation.ts`, `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, text)), file).toEqual([`import of ${textModule} (${STORED_TEXT})`]);
    }
  });

  it("allows only the store-reader pairs, refusing either reader elsewhere and every other step module from the store", () => {
    const strip = (findings: string[]) => findings.map(entry => entry.replace(/ at line \d+$/, ""));
    for (const stepModule of [DIRECTORY, GRANTS_READER]) {
      const specifier = `@/${stepModule.slice(4, -3)}`;
      const source = `import * as reader from "${specifier}";`;
      expect(stepFindings(STORE, source)).toEqual([]);
      // Every current production file except the store, plus an unlisted file.
      for (const file of [...scan().map(entry => entry.file).filter(file => file !== STORE), "src/server/example.ts"]) {
        expect(strip(stepFindings(file, source)), file).toEqual([`import of ${specifier} (${stepModule})`]);
      }
    }
    for (const stepModule of STEP_MODULES.filter(module => module !== DIRECTORY && module !== GRANTS_READER)) {
      const specifier = `@/${stepModule.slice(4, -3)}`;
      expect(strip(stepFindings(STORE, `import * as step from "${specifier}";`))).toEqual([`import of ${specifier} (${stepModule})`]);
    }
  }, 30_000);

  it("keeps the shared authority reset callable on a schema-49 database, as the quarantine at 49 runs it", () => {
    const memory = schemaAt49(new Database(":memory:"));
    try {
      // The fence triggers of the covered rows call the observer; outside an owner it is a no-op here.
      memory.function("worktree_security_pending", () => 0);
      const at = "2025-01-01T00:00:00.000Z";
      revokeCredentials(memory, at); revokeOldGrants(memory, at); releaseReservations(memory, at); cancelRemoteWork(memory, at);
      expect(() => interruptTestRuns(memory)).not.toThrow();
    } finally { memory.close(); }
  });
});
