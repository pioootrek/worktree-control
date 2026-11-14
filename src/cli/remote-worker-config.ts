import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { remoteDependencySetupSchema, remotePreparationTimeoutSchema } from "@/server/modules/remote-verification";

// Shared by the embedded `start --remote-verification-config` file and the worker-only file.
export const remoteIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const remoteNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const absolutePathSchema = z.string().refine(isAbsolute, "Absolute path required");
export const remoteWorkerMappingSchema = z.object({
  projectId: remoteIdentifierSchema, localProjectId: remoteIdentifierSchema, sourceCachePath: absolutePathSchema, sourceRemote: remoteNameSchema,
  presetIds: z.array(remoteIdentifierSchema).min(1).max(16),
  dependencySetup: remoteDependencySetupSchema.optional(), preparationTimeoutMs: remotePreparationTimeoutSchema.optional(),
}).strict();

/** Worker-only process file. Strict: a `listener` or any other unknown key is rejected. */
export const workerProcessConfigSchema = z.object({
  version: z.literal(1),
  workerId: remoteIdentifierSchema,
  origin: z.string().url(),
  credentialFile: absolutePathSchema,
  workspaceRoot: absolutePathSchema,
  allowLoopbackHttpFixture: z.boolean().default(false),
  mappings: z.array(remoteWorkerMappingSchema).min(1).max(16),
}).strict();
export type WorkerProcessConfig = z.infer<typeof workerProcessConfigSchema>;

export function loadWorkerProcessConfig(path: string): WorkerProcessConfig {
  try { return workerProcessConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error("Invalid worker configuration."); }
}

/** Reject shared or symlinked credential files rather than silently repairing permissions. */
export function readOwnerOnlyCredentialFile(path: string, maxBytes: number, label: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077 || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`${label} must be in an owner-only regular file.`);
  if (metadata.size > maxBytes) throw new Error(`Invalid ${label.toLowerCase()} file.`);
  return readFileSync(path, "utf8").trim();
}

/**
 * Opaque bearer credential: no prefix or format check, so a legacy `wts_` worker token and a later
 * installation or agent token both pass. Only its size and visible-ASCII shape are bounded.
 */
export function readWorkerCredential(path: string): string {
  const credential = readOwnerOnlyCredentialFile(path, 4096, "Worker credential");
  if (!/^[\x21-\x7e]{16,2048}$/.test(credential)) throw new Error("Invalid worker credential file.");
  return credential;
}
