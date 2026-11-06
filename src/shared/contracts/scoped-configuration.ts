import { z } from "zod";

/**
 * Scoped agent configuration (A2). `profiles:select` selects an existing literal
 * profile; `config:write` sets project-wide timeouts of presets discovered in a
 * worktree. Neither creates, edits or deletes profiles, reads ENV names or values,
 * or reaches vaults, launch, TLS, capacity or identity settings.
 */
export const SCOPED_TEST_PRESET_TIMEOUT_MAX_MS = 86_400_000;
/** Bounds the project's override map and the listed preset/profile entries. */
export const SCOPED_TEST_PRESET_OVERRIDE_LIMIT = 256;
export const SCOPED_CONFIGURATION_LIST_LIMIT = 256;

const projectId = z.string().uuid();
const worktreePath = z.string().min(1).max(4096);
const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const idempotencyKey = z.string().min(1).max(120);
/** Present only when the caller acts under its own active claim; never inferred. */
const reservationId = z.string().uuid().optional();

export const listScopedEnvironmentProfilesSchema = z.strictObject({ projectId });
export const selectScopedEnvironmentProfileSchema = z.strictObject({
  projectId,
  /** Exact existing profile name; never trimmed, created or resolved through a vault. */
  name: z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  expectedRevision,
  idempotencyKey,
  reservationId,
});
export const getScopedProjectConfigurationSchema = z.strictObject({ projectId, worktreePath });
export const setScopedTestPresetTimeoutSchema = z.strictObject({
  projectId,
  worktreePath,
  presetId: z.string().min(1).max(160).regex(/^(node|django|godot):[A-Za-z0-9._:-]+$/),
  /** Null removes the project override. */
  timeoutMs: z.number().int().min(1).max(SCOPED_TEST_PRESET_TIMEOUT_MAX_MS).nullable(),
  expectedRevision,
  idempotencyKey,
  reservationId,
});

export type SelectScopedEnvironmentProfileInput = z.infer<typeof selectScopedEnvironmentProfileSchema>;
export type GetScopedProjectConfigurationInput = z.infer<typeof getScopedProjectConfigurationSchema>;
export type SetScopedTestPresetTimeoutInput = z.infer<typeof setScopedTestPresetTimeoutSchema>;

/** Safe views: explicit allowlists, never built by spreading a project record. */
export interface ScopedEnvironmentProfiles {
  schemaVersion: 1;
  projectId: string;
  configurationRevision: number;
  selectedProfile: string;
  profiles: Array<{ name: string }>;
}

export interface ScopedProjectConfiguration {
  schemaVersion: 1;
  projectId: string;
  configurationRevision: number;
  /**
   * Presets currently discovered in the requested worktree. `timeoutMs` is the
   * discovered default; future enqueues use `overrideTimeoutMs ?? timeoutMs`.
   */
  presets: Array<{ id: string; timeoutMs: number; overrideTimeoutMs: number | null }>;
}

export type ScopedConfigurationOperation = "select_environment_profile" | "set_test_preset_timeout";

interface ScopedConfigurationReceiptBase {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  /** Revision after the operation; unchanged for a no-op. */
  configurationRevision: number;
  outcome: "completed" | "noop";
  replayed: boolean;
  observedAt: string;
}
export type ScopedConfigurationReceipt =
  | ScopedConfigurationReceiptBase & { operation: "select_environment_profile"; selectedProfile: string }
  | ScopedConfigurationReceiptBase & { operation: "set_test_preset_timeout"; presetId: string; timeoutMs: number | null };
