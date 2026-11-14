import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs";
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

// Not defined on every platform (Windows). Without it no atomic no-follow open exists, so the
// reader refuses instead of checking the path and then opening it (a symlink race).
const NO_FOLLOW: number | undefined = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;

function assertOwnerOnlyRegularFile(metadata: Stats, label: string): void {
  if (!metadata.isFile() || metadata.mode & 0o077 || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`${label} must be in an owner-only regular file.`);
}

/**
 * Reject shared or symlinked credential files rather than silently repairing permissions. The path
 * is opened once, without following a symlink or waiting for a FIFO writer; that descriptor is the
 * one validated and read, and at most one byte past the limit is read.
 */
export function readOwnerOnlyCredentialFile(path: string, maxBytes: number, label: string): string {
  if (NO_FOLLOW === undefined) throw new Error(`${label} cannot be read safely on this platform: opening a file without following a symlink is unsupported.`);
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A final symlink: ELOOP on Linux and macOS, EMLINK on FreeBSD.
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${label} must be in an owner-only regular file.`);
    // Report a missing, special, shared or oversized path as the earlier lstat-first reader did;
    // otherwise the open error itself. This metadata is used for messages only, never for reading.
    const metadata = lstatSync(path);
    assertOwnerOnlyRegularFile(metadata, label);
    if (metadata.size > maxBytes) throw new Error(`Invalid ${label.toLowerCase()} file.`);
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    assertOwnerOnlyRegularFile(metadata, label);
    if (metadata.size > maxBytes) throw new Error(`Invalid ${label.toLowerCase()} file.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    // The file grew after fstat.
    if (length > maxBytes) throw new Error(`Invalid ${label.toLowerCase()} file.`);
    return buffer.toString("utf8", 0, length).trim();
  } finally { closeSync(descriptor); }
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
