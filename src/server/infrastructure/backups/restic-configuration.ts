import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { readBoundedJson } from "@/server/infrastructure/sqlite";
import { validatePrivateDirectory } from "@/server/private-storage";
import { remoteBackupPolicySchema } from "@/server/modules/backups";

const pathSchema = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const secret = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const resticConfigurationSchema = z.object({
  executable: pathSchema, repository: z.string().min(1).max(4096), repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  passwordFile: pathSchema, credentialsFile: pathSchema, caFile: pathSchema.optional(),
  uploadKiBPerSecond: z.number().int().min(1).max(1024 * 1024).default(10240),
  policy: remoteBackupPolicySchema.default(() => remoteBackupPolicySchema.parse({})),
}).strict();
export type ResticConfiguration = z.infer<typeof resticConfigurationSchema>;
export interface LoadedResticConfiguration { configuration: ResticConfiguration; credentials: { username: string; password: string } }
const credentialsSchema = z.object({ username: secret, password: secret }).strict();

function privateInput(path: string): void {
  validatePrivateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid remote backup configuration.");
}
export function validateResticRepository(repository: string): void {
  if (!repository.startsWith("rest:https://") || /[\s\0]/.test(repository)) throw new Error("Invalid remote backup configuration.");
  const url = new URL(repository.slice(5));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error("Invalid remote backup configuration.");
}
/** CLI-only local validation; no tool execution, connection, chmod or service mutation. */
export function loadResticConfiguration(input: unknown): LoadedResticConfiguration {
  try {
    const configuration = resticConfigurationSchema.parse(input);
    validateResticRepository(configuration.repository);
    const executable = lstatSync(configuration.executable);
    if (!executable.isFile() || (executable.mode & 0o022) || (process.getuid && executable.uid !== 0 && executable.uid !== process.getuid())) throw new Error("Invalid executable.");
    accessSync(configuration.executable, constants.X_OK);
    privateInput(configuration.passwordFile);
    if (lstatSync(configuration.passwordFile).size > 16 * 1024) throw new Error("Invalid password file.");
    const key = readFileSync(configuration.passwordFile);
    if (!key.length || key.length > 16 * 1024 || key.includes(0) || !key.toString("utf8").trim()) throw new Error("Invalid password file.");
    privateInput(configuration.credentialsFile);
    const credentials = credentialsSchema.parse(readBoundedJson(configuration.credentialsFile, 16 * 1024, true));
    if (configuration.caFile) privateInput(configuration.caFile);
    return { configuration, credentials };
  } catch { throw new Error("Invalid remote backup configuration: require private key/credential files, an executable restic, an HTTPS REST repository and its repository ID."); }
}
