type Environment = Readonly<Record<string, string | undefined>>;

/** Prefix of every environment variable this product reads or sets. */
export const ENVIRONMENT_PREFIX = "WORKTREE_CONTROL_";
/** Pre-rename prefix, still honored with a deprecation warning. */
export const LEGACY_ENVIRONMENT_PREFIX = "WORKTREE_SWITCHER_";

/** Warned names per sink, so each process prints a deprecation once and tests stay independent. */
const warnedNames = new WeakMap<(message: string) => void, Set<string>>();

export function warnOnStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Legacy name for a `WORKTREE_CONTROL_*` variable. */
export function legacyEnvironmentName(name: string): string {
  if (!name.startsWith(ENVIRONMENT_PREFIX)) throw new Error(`Not a product environment variable: ${name}`);
  return LEGACY_ENVIRONMENT_PREFIX + name.slice(ENVIRONMENT_PREFIX.length);
}

/**
 * Reads a `WORKTREE_CONTROL_*` variable. When only its `WORKTREE_SWITCHER_*` predecessor is set,
 * returns that value and prints a one-line deprecation warning once per process.
 */
export function readProductEnvironment(
  environment: Environment,
  name: string,
  warn: (message: string) => void = warnOnStderr,
): string | undefined {
  const current = environment[name];
  if (current !== undefined) return current;
  const legacyName = legacyEnvironmentName(name);
  const legacy = environment[legacyName];
  if (legacy === undefined) return undefined;
  warnOnce(warn, legacyName, `Warning: ${legacyName} is deprecated; set ${name} instead.`);
  return legacy;
}

/** Prints `message` through `warn` unless the same key was already reported to that sink. */
export function warnOnce(warn: (message: string) => void, key: string, message: string): void {
  const seen = warnedNames.get(warn) ?? new Set<string>();
  warnedNames.set(warn, seen);
  if (seen.has(key)) return;
  seen.add(key);
  warn(message);
}

