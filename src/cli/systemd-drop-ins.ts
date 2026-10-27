import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const DROP_IN_LIMITS = { roots: 64, entries: 1024, files: 128, bytes: 1024 * 1024 };

export interface InspectedDropIn {
  path: string;
  contents: string;
  mask: boolean;
  mode: number;
  assignments: Array<[string, string]>;
}
export interface SystemdDropInPolicy {
  files: InspectedDropIn[];
  assignments: Array<[string, string]>;
}

function refuse(): never {
  throw new Error("Installed service configuration cannot be safely inherited. Inspect and reconcile systemd drop-ins (unsupported content, file type, unreadable input or inspection limit); no service was changed.");
}

// strcmp ordering, independent of the host locale and JavaScript UTF-16 ordering.
export function systemdLexicalCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

const resourceDropInKeys = new Set([
  "MemoryAccounting", "MemoryMin", "MemoryLow", "MemoryHigh", "MemoryMax", "MemorySwapMax", "MemoryZSwapMax",
  "CPUAccounting", "CPUWeight", "StartupCPUWeight", "CPUQuota", "CPUQuotaPeriodSec", "AllowedCPUs", "StartupAllowedCPUs",
  "AllowedMemoryNodes", "StartupAllowedMemoryNodes", "TasksAccounting", "TasksMax", "IOAccounting", "IOWeight",
  "StartupIOWeight", "IOReadBandwidthMax", "IOWriteBandwidthMax", "IOReadIOPSMax", "IOWriteIOPSMax", "Nice",
  "OOMScoreAdjust", "OOMPolicy", "ManagedOOMSwap", "ManagedOOMMemoryPressure", "ManagedOOMMemoryPressureLimit",
  "LimitAS", "LimitCORE", "LimitCPU", "LimitDATA", "LimitFSIZE", "LimitLOCKS", "LimitMEMLOCK", "LimitMSGQUEUE",
  "LimitNICE", "LimitNOFILE", "LimitNPROC", "LimitRSS", "LimitRTPRIO", "LimitRTTIME", "LimitSIGPENDING", "LimitSTACK",
]);

function assignments(contents: string): Array<[string, string]> {
  // systemd v255 WHITESPACE/strstrip only recognize space, tab, CR and LF.
  // Refuse other JS whitespace even in values/comments rather than erase policy differences.
  if (/[^\S \t\r\n]/.test(contents)) refuse();
  let section = "";
  const result: Array<[string, string]> = [];
  for (const source of contents.split(/\r?\n/)) {
    // A deliberately restricted grammar. No continuations, substitutions or ignored sections.
    const line = source.replace(/^[ \t]+|[ \t]+$/g, "");
    if (/[\0\r]/.test(source) || line.endsWith("\\")) refuse();
    if (!line || /^[#;]/.test(line)) continue;
    if (line === "[Service]") { section = "Service"; continue; }
    const match = /^([A-Za-z][A-Za-z0-9]*)[ \t]*=(.*)$/.exec(line);
    if (section !== "Service" || !match || !resourceDropInKeys.has(match[1])) refuse();
    const value = match[2].replace(/^[ \t]+|[ \t]+$/g, "");
    if (value.includes("$") || (value.includes("%") && !/^[0-9]+(?:\.[0-9]+)?%$/.test(value))) refuse();
    result.push([match[1], value]);
  }
  return result;
}

function inspectFile(path: string, budget: { bytes: number }): InspectedDropIn {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) {
    if (readlinkSync(path) !== "/dev/null") refuse();
    return { path, contents: "", mask: true, mode: 0, assignments: [] };
  }
  if (!before.isFile() || before.size > DROP_IN_LIMITS.bytes - budget.bytes) refuse();
  // O_NONBLOCK prevents a replaced FIFO from blocking; O_NOFOLLOW rejects a replaced symlink.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refuse();
    const data = Buffer.alloc(opened.size + 1);
    let size = 0, count: number;
    while (size < data.length && (count = readSync(fd, data, size, data.length - size, null)) > 0) size += count;
    const after = fstatSync(fd);
    if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) refuse();
    budget.bytes += size;
    const contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, size));
    if (contents.startsWith("\uFEFF")) refuse();
    return { path, contents, mask: false, mode: opened.mode & 0o777, assignments: assignments(contents) };
  } finally { closeSync(fd); }
}

/** Resolve only our two plain service names, using the manager's UnitPath order. */
export function inspectSystemdDropIns(roots: string[], unit: string): SystemdDropInPolicy {
  try {
    if (!["worktree-control.service", "worktree-switcher.service"].includes(unit)
      || !roots.length || roots.length > DROP_IN_LIMITS.roots || new Set(roots).size !== roots.length
      || roots.some(root => !isAbsolute(root) || normalize(root) !== root || root.includes("\0"))) refuse();
    // Named scopes: root first, specificity second. Type-wide scopes follow ALL named scopes.
    const directories = roots.flatMap(root => [join(root, `${unit}.d`), join(root, "worktree-.service.d")])
      .concat(roots.map(root => join(root, "service.d")));
    const winners = new Map<string, string>();
    const seenDirectories = new Set<string>();
    let entries = 0;
    for (const directory of directories) {
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      // UnitPath roots may have canonical aliases (e.g. /lib); drop-in directories may not.
      if (!stat.isDirectory()) refuse();
      const canonical = realpathSync(directory);
      if (seenDirectories.has(canonical)) continue;
      seenDirectories.add(canonical);
      for (const name of readSystemdDropInDirectory(canonical)) {
        if (++entries > DROP_IN_LIMITS.entries) refuse();
        if (!name.endsWith(".conf") || name.startsWith(".")) continue;
        // Do not read overridden content or revive it by copying it during migration.
        if (!winners.has(name)) winners.set(name, join(canonical, name));
        if (winners.size > DROP_IN_LIMITS.files) refuse();
      }
    }
    const budget = { bytes: 0 };
    const files = [...winners].sort(([a], [b]) => systemdLexicalCompare(a, b)).map(([, path]) => inspectFile(path, budget));
    return { files, assignments: files.flatMap(file => file.assignments) };
  } catch { return refuse(); }
}

export function sameSystemdPolicy(a: SystemdDropInPolicy, b: SystemdDropInPolicy): boolean {
  return JSON.stringify(a.assignments) === JSON.stringify(b.assignments);
}

/** Include masks/empty files and order when comparing the loaded manager's selected paths. */
export function matchesSystemdDropInPaths(policy: SystemdDropInPolicy, paths: string[]): boolean {
  return paths.length === policy.files.length && policy.files.every((file, index) => file.path === paths[index]);
}

/** Bounded directory read, also used when deciding whether legacy inputs must be retained. */
export function readSystemdDropInDirectory(directory: string): string[] {
  const result: string[] = [];
  const dir = opendirSync(directory, { encoding: "utf8", bufferSize: 1 });
  try {
    for (let entry; (entry = dir.readSync()) !== null;) {
      if (result.length >= DROP_IN_LIMITS.entries || entry.name.includes("\uFFFD")) refuse();
      result.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return result;
}

/** Decode systemctl's shell_maybe_quote(..., 0) string array without shell evaluation. */
export function parseSystemdPathList(value: string | undefined): string[] | null {
  if (value === undefined || value.length > 1024 * 1024) return null;
  const paths: string[] = [];
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "`": "`", $: "$" };
  // systemd emits whole double-quoted words, never shell concatenation or single quotes.
  const words = /"((?:\\.|[^"\\])*)"|([^ ]+)/gy;
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === " ") { offset++; continue; }
    words.lastIndex = offset;
    const match = words.exec(value);
    if (!match || (words.lastIndex < value.length && value[words.lastIndex] !== " ")) return null;
    offset = words.lastIndex;
    let path = match[2];
    if (match[1] !== undefined) {
      const bytes: Buffer[] = [];
      const parts = /\\([abfnrtv\\"`$]|[0-7]{3})|([^\\]+)/gy;
      let position = 0;
      while (position < match[1].length) {
        parts.lastIndex = position;
        const part = parts.exec(match[1]);
        if (!part) return null;
        position = parts.lastIndex;
        if (part[2] !== undefined) bytes.push(Buffer.from(part[2]));
        else if (part[1] in escapes) bytes.push(Buffer.from(escapes[part[1]]));
        else {
          const byte = Number.parseInt(part[1], 8);
          if (byte === 0 || byte > 255) return null;
          bytes.push(Buffer.from([byte]));
        }
      }
      try { path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(bytes)); }
      catch { return null; }
    } else if (/[\s"'\\`$?*\[\]()<>|&;!]/.test(path)) return null;
    if (!isAbsolute(path) || path.includes("\0") || paths.length >= 128) return null;
    paths.push(path);
  }
  return paths;
}

