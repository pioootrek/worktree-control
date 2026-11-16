import { resolve } from "node:path";
import { AuthenticationProviderError, ProviderAdminError, providerAdminErrorBody } from "../server/modules/authentication";
import type { AppPaths } from "../server/paths";
import { readBoundedJson, UPGRADE_PLAN_LIMITS, UpgradeError } from "../server/infrastructure/sqlite";
import { applyUpgrade, inspectUpgrade, type UpgradeInspection } from "../server/bootstrap/upgrade-maintenance";

/*
 * The `upgrade` command's runner (integration branch, provisional). It is not
 * registered: no file but its tests imports it until the activation adds it
 * to `src/cli/index.ts` and its help (`provisional-schema.test.ts` guards
 * this). No secret arguments, no online fallback, offline only.
 *
 *   upgrade inspect [--decisions <file>]
 *   upgrade apply --expect <64 hex> --backup-dir <dir>
 *
 * Both also accept `--data-dir` and `--state-dir` once each, which the caller
 * has already resolved into `paths`, as for `auth fence`.
 */

/** Largest decisions file read: the plan that stores the decisions has the same bound. */
export const UPGRADE_DECISIONS_FILE_BYTES = UPGRADE_PLAN_LIMITS.bytes;

export type UpgradeCliCommand =
  | { action: "inspect"; decisions?: string }
  | { action: "apply"; expect: string; backupDirectory: string };

const FLAGS: Readonly<Record<UpgradeCliCommand["action"], readonly string[]>> = {
  inspect: ["--decisions", "--data-dir", "--state-dir"],
  apply: ["--expect", "--backup-dir", "--data-dir", "--state-dir"],
};
const invalid = () => new UpgradeError("upgrade_invalid_input", "upgrade inspect");

/**
 * Strict parsing, before any file, lock or database: `args` starts with
 * `upgrade`, then the action, then flags each given once with a value that is
 * not itself a flag. Anything else is `upgrade_invalid_input`.
 */
export function parseUpgradeArguments(args: readonly string[]): UpgradeCliCommand {
  const positional: string[] = [], flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (!item.startsWith("-")) { positional.push(item); continue; }
    if (flags.has(item) || ![...FLAGS.inspect, ...FLAGS.apply].includes(item)) throw invalid();
    const value = args[++index];
    if (value === undefined || value === "" || value.startsWith("--") || value.includes("\0")) throw invalid();
    flags.set(item, value);
  }
  if (positional.length !== 2 || positional[0] !== "upgrade" || (positional[1] !== "inspect" && positional[1] !== "apply")) throw invalid();
  const action = positional[1];
  if ([...flags.keys()].some(flag => !FLAGS[action].includes(flag))) throw invalid();
  if (action === "inspect") {
    const decisions = flags.get("--decisions");
    if (decisions !== undefined && !decisions.trim()) throw invalid();
    return decisions === undefined ? { action } : { action, decisions: resolve(decisions) };
  }
  const expect = flags.get("--expect"), directory = flags.get("--backup-dir");
  if (!expect || !/^[0-9a-f]{64}$/.test(expect)) throw invalid();
  // As `--backup-dir` of start and service install (migration-backup-options.ts): one non-blank directory, no NUL, made absolute.
  if (!directory?.trim()) throw invalid();
  return { action, expect, backupDirectory: resolve(directory) };
}

/**
 * The operator's decisions: a regular file (no symbolic link, directory, FIFO
 * or device; one swapped in after the check is refused without blocking), at most {@link UPGRADE_DECISIONS_FILE_BYTES}, UTF-8 JSON without
 * duplicate keys. Hard links are accepted: the file is only read. Its content
 * is checked by the act domains; any failure here is `upgrade_invalid_input`
 * and names neither the file nor its content.
 */
export function readUpgradeDecisions(file: string): unknown {
  try { return readBoundedJson(file, UPGRADE_DECISIONS_FILE_BYTES, false, true); } catch { throw invalid(); }
}

/** What `upgrade inspect` prints: the status and, when an upgrade is needed, the plan's hash, decisions, operator lines and review; never the plan itself. */
export function upgradeInspectionOutput(inspection: UpgradeInspection) {
  const { state, nextStep, schemaVersion, target, preflight, marker, appliedPlan, planHash, decisions, acts, review } = inspection;
  return { state, nextStep, schemaVersion, target, preflight, marker, appliedPlan,
    ...(planHash === undefined ? {} : { planHash, decisions, acts, review }) };
}

/**
 * Runs `upgrade inspect` or `upgrade apply` and writes one JSON document.
 * Errors are thrown; the caller prints them with {@link upgradeErrorBody}.
 * `target` is for tests at the provisional target.
 */
export async function runUpgradeCommand(args: readonly string[], paths: AppPaths, write: (line: string) => void, options: { applicationVersion: string; target?: number }): Promise<void> {
  const command = parseUpgradeArguments(args);
  if (command.action === "inspect") {
    const decisions = command.decisions === undefined ? undefined : readUpgradeDecisions(command.decisions);
    write(JSON.stringify(upgradeInspectionOutput(inspectUpgrade(paths, decisions, options.target)), null, 2));
    return;
  }
  const result = await applyUpgrade(paths, { expect: command.expect }, { directory: command.backupDirectory, applicationVersion: options.applicationVersion }, options.target);
  write(JSON.stringify(result, null, 2));
}

/** The fixed body of a failure no known error type describes. */
export const UPGRADE_FAILED = Object.freeze({
  code: "upgrade_failed", error: "The upgrade command failed. Nothing about the cause is reported; run upgrade inspect before another attempt.", nextStep: "upgrade inspect",
} as const);

/**
 * The JSON error body of a thrown error. An `UpgradeError` gives its code,
 * message and next step, with its state, `committed: true` and bounded row
 * details when it has them; fence and provider errors give the fixed body of
 * `providerAdminErrorBody`; anything else is {@link UPGRADE_FAILED}. No body
 * carries a library message, path, secret or file content: every message is
 * fixed text and details hold IDs only.
 */
export function upgradeErrorBody(error: unknown): Record<string, unknown> {
  if (error instanceof UpgradeError) {
    return { code: error.code, error: error.message, nextStep: error.nextStep, ...(error.state ? { state: error.state } : {}),
      ...(error.committed ? { committed: true as const } : {}), ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof AuthenticationProviderError || error instanceof ProviderAdminError) return providerAdminErrorBody(error);
  return { ...UPGRADE_FAILED };
}
