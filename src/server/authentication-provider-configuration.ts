import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { durableJson, privateDirectory, readPrivateBoundedFile, validateSensitivePath } from "./private-storage";
import { parseStrictProviderJson, ProviderAdminError, providerConfigurationInputSchema, type ProviderConfiguration, type ProviderConfigurationInput, type ProviderConfigurationPort } from "./modules/authentication";

export const PROVIDER_INPUT_LIMIT = 8 * 1024;
const persisted = z.object({ format: z.literal(1), providerId: z.literal("better-auth"),
  entry: z.string().max(4096), baseURL: z.string().max(2048), secret: z.string().max(512) }).strict();

export function decodeProviderJson(bytes: Uint8Array): unknown {
  try {
    if (!bytes.byteLength || bytes.byteLength > PROVIDER_INPUT_LIMIT) throw new Error();
    return parseStrictProviderJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { maxDepth: 8, maxFields: 128 });
  } catch { throw new ProviderAdminError("invalid_input"); }
}

export function validateProviderEntry(entry: string): string {
  try {
    let path = entry;
    if (entry.startsWith("file:")) {
      const url = new URL(entry);
      if (url.host || url.search || url.hash || entry.includes("?") || entry.includes("#")) throw new Error();
      path = fileURLToPath(url);
    }
    if (!isAbsolute(path)) throw new Error();
    for (let current = path; ; current = dirname(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) && !(stat.isDirectory() && (stat.mode & 0o1000))) throw new Error();
      if (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0) throw new Error();
      if (current === path && (!stat.isFile() || (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0))) throw new Error();
      if (current === dirname(current)) break;
    }
    return pathToFileURL(realpathSync(path)).href;
  } catch { throw new ProviderAdminError("configuration_invalid"); }
}
function originBaseURL(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value.includes("?") || value.includes("#")) throw new Error();
    return `${url.origin}/api/auth`;
  } catch { throw new ProviderAdminError("configuration_invalid"); }
}
function signingMaterial(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(value) || bytes.length < 32 || bytes.length > 128 || bytes.toString("base64url") !== value) {
    throw new ProviderAdminError("configuration_invalid");
  }
  return value;
}

/** One private file is the durable authority. SQLite snapshots do not back it up. */
export class FileProviderConfiguration implements ProviderConfigurationPort {
  constructor(private readonly path: string, private readonly excludedRoots: () => readonly string[] = () => [],
    private readonly event?: () => void) {}

  read(): ProviderConfiguration | null {
    const value = this.readPersisted();
    if (value && validateProviderEntry(value.entry) !== value.entry) throw new ProviderAdminError("configuration_invalid");
    return value;
  }

  /** Reconfiguration needs intact signing material, not an executable old module. */
  private readPersisted(): ProviderConfiguration | null {
    try {
      validateSensitivePath(this.path, this.excludedRoots(), true);
      try { lstatSync(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const value = persisted.parse(decodeProviderJson(readPrivateBoundedFile(this.path, PROVIDER_INPUT_LIMIT, this.excludedRoots())));
      const entry = new URL(value.entry);
      if (entry.protocol !== "file:" || entry.host || entry.search || entry.hash
        || pathToFileURL(fileURLToPath(entry)).href !== value.entry
        || originBaseURL(new URL(value.baseURL).origin) !== value.baseURL) throw new Error();
      signingMaterial(value.secret);
      return value;
    } catch { throw new ProviderAdminError("configuration_invalid"); }
  }

  configure(input: ProviderConfigurationInput, hasProviderData: boolean): void {
    const parsed = providerConfigurationInputSchema.safeParse(input);
    if (!parsed.success) throw new ProviderAdminError("invalid_input");
    const entry = validateProviderEntry(input.module), baseURL = originBaseURL(input.origin);
    const existing = this.readPersisted();
    if (!existing && hasProviderData) throw new ProviderAdminError("configuration_restore_required");
    let secret: string;
    if (existing) {
      if (input.signingSecret.kind === "generate" || (input.signingSecret.kind === "supplied" && signingMaterial(input.signingSecret.value) !== existing.secret)) {
        throw new ProviderAdminError("configuration_secret_preservation_required");
      }
      secret = existing.secret;
    } else {
      if (input.signingSecret.kind === "preserve") throw new ProviderAdminError("configuration_missing");
      secret = input.signingSecret.kind === "generate" ? randomBytes(32).toString("base64url") : signingMaterial(input.signingSecret.value);
    }
    try {
      validateSensitivePath(this.path, this.excludedRoots(), true);
      privateDirectory(dirname(this.path));
      durableJson(this.path, { format: 1, providerId: "better-auth", entry, baseURL, secret } satisfies ProviderConfiguration);
    } catch { throw new ProviderAdminError("configuration_write_unconfirmed"); }
    // Operational event only. Never claim an atomic filesystem+SQLite audit.
    try { this.event?.(); } catch { /* The durable file remains authority. */ }
  }
}
