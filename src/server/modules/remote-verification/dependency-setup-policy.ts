import { isAbsolute } from "node:path";
import { z } from "zod";

/** Privileged worker-local configuration, never accepted from a remote assignment. */
export const remoteDependencySetupSchema = z.object({
  kind: z.literal("pnpm"),
  nodeExecutable: z.string().refine(isAbsolute),
  nodeVersion: z.string().regex(/^(?:2[2-9]|[3-9][0-9])\.\d+\.\d+$/),
  pnpmEntryPoint: z.string().refine(isAbsolute),
  pnpmVersion: z.string().regex(/^11\.(?:[1-9][0-9]*)\.\d+$/),
  scripts: z.enum(["ignore", "trusted-repository"]),
}).strict();
export type RemoteDependencySetupPolicy = z.infer<typeof remoteDependencySetupSchema>;
export const remotePreparationTimeoutSchema = z.number().int().min(1_000).max(30 * 60_000);
