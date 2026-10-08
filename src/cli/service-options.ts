import { BACKUP_OPERATION_FLAGS } from "./backup-policy-options";
import { MCP_SESSION_VALUE_FLAGS } from "./mcp-session-options";
import { REMOTE_BACKUP_VALUE_FLAGS } from "./remote-backup-options";
import { USER_BACKUP_VALUE_FLAGS } from "./user-backup-options";

const pathFlags = ["--data-dir", "--state-dir"];
const valueFlags = new Set([
  ...pathFlags, "--host", "--port", "--mcp-port", "--browse-root", "--web-root",
  "--memory-warning-mib", "--public-url", "--backup-dir", ...BACKUP_OPERATION_FLAGS,
  ...REMOTE_BACKUP_VALUE_FLAGS, ...USER_BACKUP_VALUE_FLAGS, ...MCP_SESSION_VALUE_FLAGS,
]);
const booleanFlags = new Set([
  "--no-mcp", "--backup-before-migration", "--user-backup-enabled",
  "--backup-remote-enabled", "--backup-remote-disabled",
]);
const installFlags = new Set(["--refresh", "--print", "--yes", "--unset"]);
const internalFlags = new Set(["--service-mode", "--no-open"]);
const actions = new Set(["install", "status", "start", "stop", "restart", "url", "open", "uninstall"]);
export const SERVICE_USAGE = "Usage: service install [startup options] [--refresh] [--print] [--yes] [--unset STARTUP_FLAG] | service status|start|stop|restart|url|open|uninstall [--data-dir PATH] [--state-dir PATH]. --print previews without installing; --yes accepts changed legacy settings; repeat --unset to reset inherited options.";

type Options = Map<string, string[]>;

function parseOptions(args: string[], mode: "install" | "installed" | "other"): Options {
  const options: Options = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--unset" && mode === "install") {
      const target = args[++i];
      const removals = options.get(flag) ?? [];
      if ((!valueFlags.has(target) && !booleanFlags.has(target)) || removals.includes(target)) {
        throw new Error(`--unset requires one known startup flag, once per setting. ${SERVICE_USAGE}`);
      }
      removals.push(target);
      options.set(flag, removals);
      continue;
    }
    const allowed = mode === "other" ? pathFlags.includes(flag)
      : valueFlags.has(flag) || booleanFlags.has(flag) || (mode === "install" ? installFlags.has(flag) : internalFlags.has(flag));
    // Do not echo unknown input: an accidental credential can occupy this position.
    if (!allowed) throw new Error(`Unsupported service option or argument. ${SERVICE_USAGE}`);
    if (options.has(flag) && flag !== "--user-backup-target") throw new Error(`Duplicate service option: ${flag}. ${SERVICE_USAGE}`);
    const values = options.get(flag) ?? [];
    if (valueFlags.has(flag)) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error(`${flag} requires one value. ${SERVICE_USAGE}`);
      values.push(value);
    }
    options.set(flag, values);
  }
  if (options.get("--unset")?.some(flag => options.has(flag))) throw new Error("Cannot both set and unset the same service option.");
  return options;
}

/** Validate before reading configuration, writing directories or calling a service manager. */
export function validateServiceCommand(args: string[]): void {
  const action = args[0] ?? "status";
  if (!actions.has(action)) throw new Error(SERVICE_USAGE);
  parseOptions(args.slice(1), action === "install" ? "install" : "other");
}

function flatten(options: Options): string[] {
  return [...options].flatMap(([flag, values]) => values.length ? values.flatMap(value => [flag, value]) : [flag]);
}

/** Preserve every installed startup setting; explicit options override only their own setting. */
export function resolveServiceInstallArguments(args: string[], installed: string[] | null): {
  args: string[]; changes: string[];
} {
  const previous = parseOptions(installed ?? [], "installed");
  const overrides = parseOptions(args.slice(1), "install");
  const merged = new Map(previous);
  // A new package supplies its own static assets unless explicitly overridden.
  merged.delete("--web-root");
  for (const flag of internalFlags) merged.delete(flag);
  for (const flag of overrides.get("--unset") ?? []) merged.delete(flag);
  if (overrides.has("--backup-remote-disabled")) {
    for (const flag of merged.keys()) if (flag.startsWith("--backup-remote")) merged.delete(flag);
  }
  for (const [flag, values] of overrides) if (!installFlags.has(flag)) merged.set(flag, values);
  return { args: flatten(merged), changes: serviceSettingChanges(installed, flatten(merged)) };
}

/** Compare requested settings with the actual serialized values used by the generated service. */
export function serviceSettingChanges(installed: string[] | null, intended: string[], effective = intended): string[] {
  const previous = parseOptions(installed ?? [], "installed");
  const merged = parseOptions(intended, "installed");
  const generated = parseOptions(effective, "installed");
  const changes: string[] = [];
  if (installed) {
    for (const flag of new Set([...previous.keys(), ...merged.keys()])) {
      if (flag === "--web-root" || internalFlags.has(flag)) continue;
      const before = previous.get(flag), after = generated.get(flag);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const show = (values: string[] | undefined) => values === undefined ? "(unset; controller default)" : !values.length ? "enabled"
        : flag === "--backup-remote-repository" ? "(configured; value redacted)" : JSON.stringify(values);
      changes.push(`${flag}: ${show(before)} -> ${show(after)}`);
    }
  }
  return changes;
}
