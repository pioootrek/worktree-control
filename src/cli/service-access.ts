import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readProductEnvironment } from "../server/product-environment";

export interface ServiceAccessRecord {
  pid: number;
  startedAt: string;
  version: string;
  dashboardEndpoint: string;
  localDashboardEndpoint?: string;
  publicDashboardEndpoint?: string;
  mcpEndpoint: string | null;
  accessUrl: string;
  logDirectory: string;
  /** Absent in records written before authentication modes existed, which were legacy. */
  authenticationMode?: string;
}

export function writeServiceAccess(path: string, record: ServiceAccessRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

export function readServiceAccess(path: string): ServiceAccessRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceAccessRecord>;
    if (
      typeof value.pid !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.version !== "string" ||
      typeof value.dashboardEndpoint !== "string" ||
      !(value.localDashboardEndpoint === undefined || typeof value.localDashboardEndpoint === "string") ||
      !(value.publicDashboardEndpoint === undefined || typeof value.publicDashboardEndpoint === "string") ||
      !(typeof value.mcpEndpoint === "string" || value.mcpEndpoint === null) ||
      typeof value.accessUrl !== "string" ||
      typeof value.logDirectory !== "string" ||
      !(value.authenticationMode === undefined || typeof value.authenticationMode === "string")
    ) return null;
    return value as ServiceAccessRecord;
  } catch {
    return null;
  }
}

/**
 * Token for CLI calls to the running controller: WORKTREE_CONTROL_TOKEN (the installation token
 * in token mode) or, in legacy mode, the pairing token embedded in the access URL.
 */
export function controllerAccessToken(
  record: ServiceAccessRecord,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const supplied = readProductEnvironment(environment, "WORKTREE_CONTROL_TOKEN");
  if (supplied) return supplied;
  try {
    return new URLSearchParams(new URL(record.accessUrl).hash.slice(1)).get("token");
  } catch {
    return null;
  }
}

export function localDashboardEndpoint(record: ServiceAccessRecord): string {
  if (record.localDashboardEndpoint) return record.localDashboardEndpoint;
  return record.dashboardEndpoint;
}

export function publicDashboardEndpoint(record: ServiceAccessRecord): string {
  return record.publicDashboardEndpoint ?? record.dashboardEndpoint;
}

export function removeServiceAccess(path: string, pid = process.pid): void {
  const current = readServiceAccess(path);
  if (!current || current.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
