import { DEV_DOTENV_BYTES } from "@/shared/contracts/dev-vault";
import { DevVaultError } from "./contracts";

const reserved = new Set(["PORT", "NODE_ENV", "PATH", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "HOME", "TMPDIR", "BASH_ENV", "ENV", "SHELLOPTS", "IFS"]);
/** Deliberately small dotenv dialect. No shell, multiline, escapes or interpolation. */
export function parseDevDotenv(input: string): Record<string, string> {
  const fail = (): never => { throw new DevVaultError("vault_invalid_request"); };
  if (Buffer.byteLength(input) > DEV_DOTENV_BYTES) fail();
  for (const character of input) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) fail();
  }
  const entries = new Map<string, string>();
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/.exec(line);
    if (!match) fail();
    const [, name, tail] = match!;
    if (entries.has(name) || reserved.has(name) || /^(DYLD_|WORKTREE_CONTROL_|WORKTREE_SWITCHER_)/.test(name) || name === "__proto__") fail();
    let value = tail.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) fail();
      value = value.slice(1, -1);
      if (/["'\\]/.test(value)) fail();
    } else if (/[\s"'\\#]/.test(value)) fail();
    if (/[`$\r\n]/.test(value) || Buffer.byteLength(value) > 8192) fail();
    if (/^(APP_ENV|ENVIRONMENT|DEPLOYMENT_ENV|STAGE)$/.test(name) && /^(prod(uction)?|stag(e|ing))$/i.test(value)) fail();
    entries.set(name, value);
    if (entries.size > 100) fail();
  }
  if (entries.size === 0) fail();
  return Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : 1));
}
