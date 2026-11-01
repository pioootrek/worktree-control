import type { Readable } from "node:stream";
import { readPrivateBoundedFile } from "../server/private-storage";
import { decodeProviderJson, PROVIDER_INPUT_LIMIT } from "../server/authentication-provider-configuration";
import { parseProviderAdminCommand, ProviderAdminError, type ProviderAdminCommand } from "../server/modules/authentication";

/** Parses raw flags before global path stripping, secret reads, locks or SQLite. */
export function isProviderCommandArgs(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--data-dir" || args[index] === "--state-dir") { index++; continue; }
    return args[index] === "provider";
  }
  return false;
}

export function parseProviderArguments(args: readonly string[]) {
  const positional: string[] = [], values = new Map<string, string | true>();
  const valueFlags = new Set(["--data-dir", "--state-dir", "--principal-id", "--input-file"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("-")) { positional.push(value); continue; }
    if (values.has(value)) throw new ProviderAdminError("invalid_input");
    if (value === "--input-stdin") values.set(value, true);
    else if (valueFlags.has(value)) {
      const next = args[++index];
      if (!next || next.startsWith("-") || next.length > 4096) throw new ProviderAdminError("invalid_input");
      values.set(value, next);
    } else throw new ProviderAdminError("invalid_input");
  }
  if (positional.shift() !== "provider") throw new ProviderAdminError("invalid_input");
  const action = positional.join(" ");
  if (!["status", "configure", "owner create", "enroll", "recover"].includes(action)) throw new ProviderAdminError("invalid_input");
  const sensitive = action === "configure" || action === "enroll" || action === "recover";
  const stdin = values.has("--input-stdin"), file = values.get("--input-file") as string | undefined;
  const principalId = values.get("--principal-id") as string | undefined;
  if (sensitive ? Number(stdin) + Number(Boolean(file)) !== 1 : stdin || file) throw new ProviderAdminError("invalid_input");
  if ((action === "enroll" || action === "recover") ? !principalId : action !== "status" && principalId) throw new ProviderAdminError("invalid_input");
  if (principalId && principalId.length > 1024) throw new ProviderAdminError("invalid_input");
  return { action, principalId, stdin, file, dataDir: values.get("--data-dir") as string | undefined,
    stateDir: values.get("--state-dir") as string | undefined };
}

export function readProviderStdin(input: Readable & { isTTY?: boolean }, timeoutMs = 10_000): Promise<Buffer> {
  // Sensitive input must come from a private pipe, never an echoing terminal.
  if (input.isTTY) return Promise.reject(new ProviderAdminError("invalid_input"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer); input.off("data", data); input.off("end", end); input.off("error", failed); input.off("close", closed); input.pause();
      if (error) reject(error); else resolve(Buffer.concat(chunks, bytes));
    };
    const failed = () => finish(new ProviderAdminError("invalid_input"));
    const closed = () => { if (!input.readableEnded) failed(); };
    const data = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > PROVIDER_INPUT_LIMIT) failed(); else chunks.push(chunk);
    };
    const end = () => finish();
    const timer = setTimeout(failed, timeoutMs);
    input.on("data", data); input.once("end", end); input.once("error", failed); input.once("close", closed);
    if (input.readableEnded || input.destroyed) failed();
  });
}

export async function providerCommandFromArgs(args: string[], input: Readable = process.stdin): Promise<ProviderAdminCommand> {
  const parsed = parseProviderArguments(args);
  let body: unknown;
  if (parsed.stdin || parsed.file) {
    try { body = decodeProviderJson(parsed.file ? readPrivateBoundedFile(parsed.file, PROVIDER_INPUT_LIMIT) : await readProviderStdin(input)); }
    catch { throw new ProviderAdminError("invalid_input"); }
  }
  const action = parsed.action === "owner create" ? "owner-create" : parsed.action;
  return parseProviderAdminCommand({ command: "auth-provider", action,
    ...(parsed.principalId === undefined ? {} : { principalId: parsed.principalId }),
    ...(parsed.stdin || parsed.file ? { input: body } : {}) });
}
