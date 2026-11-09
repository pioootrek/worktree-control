import { createHash } from "node:crypto";
import type { HumanRuntimeAuthority } from "../identity";
import type { HumanConfigurationMutation } from "@/shared/contracts/human-configuration";
import type { ScopedConfigurationReceipt } from "@/shared/contracts/scoped-configuration";

/** Frozen original authority and no-claim/exact-lease placement; server-only. */
export interface HumanConfigurationIntent {
  authority: HumanRuntimeAuthority;
  request: HumanConfigurationMutation;
  projectId: string;
  key: string;
  fingerprint: string;
  reservationId: string | null;
  worktreePath: string | null;
}
export interface HumanConfigurationCommit {
  intent: HumanConfigurationIntent;
  operationId: string;
}
export interface HumanConfigurationStore {
  beginHumanConfiguration(intent: HumanConfigurationIntent): ScopedConfigurationReceipt | null;
  commitHumanConfiguration(input: HumanConfigurationCommit): ScopedConfigurationReceipt;
}

/** Includes the frozen effective placement, including a profile mutation's original pinned lease. */
export function humanConfigurationFingerprint(intent: Pick<HumanConfigurationIntent, "request" | "reservationId" | "worktreePath">): string {
  return createHash("sha256").update(JSON.stringify(["human-configuration", intent.request, intent.reservationId, intent.worktreePath])).digest("hex");
}
