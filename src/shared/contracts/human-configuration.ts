import { z } from "zod";
import { listScopedEnvironmentProfilesSchema, selectScopedEnvironmentProfileSchema, getScopedProjectConfigurationSchema, setScopedTestPresetTimeoutSchema } from "./scoped-configuration";

/** Resource/intent only; authenticated authority never comes from these DTOs. */
export const humanConfigurationMutationSchema = z.discriminatedUnion("operation", [
  selectScopedEnvironmentProfileSchema.extend({ operation: z.literal("select_environment_profile") }).strict(),
  setScopedTestPresetTimeoutSchema.extend({ operation: z.literal("set_test_preset_timeout") }).strict(),
]);
export type HumanConfigurationMutation = z.infer<typeof humanConfigurationMutationSchema>;
export const humanConfigurationSchema = z.discriminatedUnion("operation", [
  listScopedEnvironmentProfilesSchema.extend({ operation: z.literal("profiles") }).strict(),
  selectScopedEnvironmentProfileSchema.extend({ operation: z.literal("select_environment_profile") }).strict(),
  getScopedProjectConfigurationSchema.extend({ operation: z.literal("configuration") }).strict(),
  setScopedTestPresetTimeoutSchema.extend({ operation: z.literal("set_test_preset_timeout") }).strict(),
]);
export type HumanConfigurationRequest = z.infer<typeof humanConfigurationSchema>;
