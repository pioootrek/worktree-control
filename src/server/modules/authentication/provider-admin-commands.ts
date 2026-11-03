import { humanPageSchema, humanMembershipPageSchema, humanKnowledgeSetSchema, humanKnowledgeRevokeSchema } from "@/shared/contracts/human-accounts";
import { HumanAccountError } from "../identity";
import { z } from "zod";
import { databaseAdmissionFailure } from "../../database-admission";
import { AuthenticationProviderError } from "./provider-runtime";

const text = z.string().min(1).max(1024);
export const providerConfigurationInputSchema = z.object({
  module: z.string().min(1).max(4096), origin: z.string().min(1).max(2048),
  signingSecret: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("generate") }).strict(),
    z.object({ kind: z.literal("preserve") }).strict(),
    z.object({ kind: z.literal("supplied"), value: z.string().min(1).max(512) }).strict(),
  ]),
}).strict();
export type ProviderConfigurationInput = z.infer<typeof providerConfigurationInputSchema>;
export const providerEnrollmentInputSchema = z.object({ email: text, name: text, password: text }).strict();
export const providerRecoveryInputSchema = z.object({ newPassword: text }).strict();
const command = z.literal("auth-provider");
const commandSchema = z.discriminatedUnion("action", [
  z.object({ command, action: z.literal("status"), principalId: text.optional() }).strict(),
  z.object({ command, action: z.literal("configure"), input: providerConfigurationInputSchema }).strict(),
  z.object({ command, action: z.literal("owner-create") }).strict(),
  z.object({ command, action: z.literal("human-create") }).strict(),
  z.object({ command, action: z.literal("human-list"), input: humanPageSchema }).strict(),
  z.object({ command, action: z.literal("human-disable"), principalId: z.string().min(1).max(160) }).strict(),
  z.object({ command, action: z.literal("knowledge-access-list"), input: humanMembershipPageSchema }).strict(),
  z.object({ command, action: z.literal("knowledge-access-set"), input: humanKnowledgeSetSchema }).strict(),
  z.object({ command, action: z.literal("knowledge-access-revoke"), input: humanKnowledgeRevokeSchema }).strict(),
  z.object({ command, action: z.literal("enroll"), principalId: text, input: providerEnrollmentInputSchema }).strict(),
  z.object({ command, action: z.literal("recover"), principalId: text, input: providerRecoveryInputSchema }).strict(),
]);
export type ProviderAdminCommand = z.infer<typeof commandSchema>;

const messages = {
  invalid_input: "Invalid protected provider administration input.",
  provider_unavailable: "The authentication provider is unavailable.",
  provider_failed: "The authentication provider operation failed; inspect state before another explicit operation.",
  principal_unavailable: "The requested account principal is unavailable.",
  membership_revision_conflict: "Human Knowledge membership revision changed; inspect current state before another explicit operation.",
  owner_already_initialized: "An owner principal already exists. Inspect private provider status.",
  subject_conflict: "The principal has provider enrollment history; enrollment is refused.",
  not_linked: "The principal has no active provider enrollment.",
  invalidation_failed: "The committed change could not notify provider consumers.",
  configuration_missing: "Protected provider configuration is missing. Restore existing material before recovery.",
  configuration_invalid: "Protected provider configuration or its file permissions are invalid.",
  configuration_secret_preservation_required: "Existing signing material must be preserved.",
  configuration_restore_required: "Provider data exists. Restore the protected configuration; new signing material is refused.",
  configuration_write_unconfirmed: "Provider configuration publication was not confirmed. Inspect private status before another explicit operation.",
  provider_configuration_restart_required: "Provider configuration changed. A new controller owner boot is required before account maintenance.",
  maintenance: "Controller provider administration is stopping or in maintenance.",
  disposal_unconfirmed: "Provider cleanup is unconfirmed; ownership is retained. Operator recovery is required.",
  database_busy: "The controller database is busy.",
  database_unavailable: "The controller database is unavailable.",
  database_admission_error: "The provider database lifetime is unavailable.",
  admin_outcome_unknown: "The protected administration outcome is unknown. Inspect state; no operation was replayed.",
} as const;
export type ProviderAdminErrorCode = keyof typeof messages;
export class ProviderAdminError extends Error {
  constructor(readonly code: ProviderAdminErrorCode, readonly committed?: true, readonly cleanupConfirmed?: false) {
    super(messages[code]); this.name = "ProviderAdminError";
  }
}
export function parseProviderAdminCommand(value: unknown): ProviderAdminCommand {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) throw new ProviderAdminError("invalid_input");
  return parsed.data;
}
/** Only trusted core error types can assert a committed effect or uncertain cleanup. */
export function providerAdminFailure(error: unknown): ProviderAdminError {
  if (error instanceof ProviderAdminError) return error;
  if (error instanceof HumanAccountError) return new ProviderAdminError(error.code);
  if (error instanceof AuthenticationProviderError) {
    const code = error.code in messages ? error.code as ProviderAdminErrorCode : "provider_failed";
    return new ProviderAdminError(code, error.committed ? true : undefined,
      error.code === "disposal_unconfirmed" ? false : undefined);
  }
  const admission = databaseAdmissionFailure(error);
  if (admission) return new ProviderAdminError(admission.code);
  return new ProviderAdminError("provider_failed");
}
export function providerAdminErrorBody(error: unknown) {
  const safe = providerAdminFailure(error);
  return { code: safe.code, error: safe.message, ...(safe.committed ? { committed: true as const } : {}),
    ...(safe.cleanupConfirmed === false ? { cleanupConfirmed: false as const } : {}) };
}
