import type { EnvironmentProfile, Project, TestEnvironmentProfile, TestPreset, Worktree } from "@/shared/contracts";

/**
 * Environment names a test process may inherit from the controller. The list is
 * deliberate and versioned: everything outside it stays undefined, so a test run
 * cannot depend on how the controller itself was started.
 */
export const SYSTEM_ENVIRONMENT_ALLOWLIST = [
  "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TZ", "USER",
] as const;

const ALLOWLIST = new Set<string>(SYSTEM_ENVIRONMENT_ALLOWLIST);

export interface ResolvedTestEnvironment {
  environment: Record<string, string>;
  mode: TestEnvironmentProfile["policy"]["mode"];
  profile: string;
  inheritedServerProfile: string | null;
  variableNames: string[];
}

export interface TestEnvironmentInput {
  project: Project;
  worktree: Worktree;
  profile: TestEnvironmentProfile;
  controllerEnvironment?: Readonly<Record<string, string | undefined>>;
}

export function systemEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([name, value]) => typeof value === "string" && (ALLOWLIST.has(name) || name.startsWith("LC_")))
      .map(([name, value]) => [name, value as string]),
  );
}

function serverProfileEnvironment(project: Project, name: string): Record<string, string> {
  const profile: EnvironmentProfile | undefined = project.environmentProfiles.find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Profil środowiska serwera ${name} nie istnieje, więc test nie może go użyć.`);
  return profile.environment;
}

export function resolveTestEnvironment(input: TestEnvironmentInput): ResolvedTestEnvironment {
  const { project, worktree, profile } = input;
  const inherited = profile.policy.mode === "inherit-server-profile" ? profile.policy.serverProfile : null;
  if (profile.policy.mode === "inherit-server-profile" && !inherited) {
    throw new Error("Profil testowy dziedziczący środowisko serwera musi wskazywać profil po nazwie.");
  }
  const environment: Record<string, string> = {
    ...systemEnvironment(input.controllerEnvironment ?? process.env),
    ...(inherited ? serverProfileEnvironment(project, inherited) : {}),
    ...profile.environment,
    ...controllerMetadata(project, worktree, profile),
    ...(profile.nodeEnv ? { NODE_ENV: profile.nodeEnv } : {}),
  };
  const missing = profile.requiredVariables.filter((name) => environment[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Profil testowy ${profile.name} wymaga zmiennych, których nie zdefiniowano: ${missing.join(", ")}.`);
  }
  return {
    environment,
    mode: profile.policy.mode,
    profile: profile.name,
    inheritedServerProfile: inherited,
    variableNames: Object.keys(environment).sort((left, right) => left.localeCompare(right)),
  };
}

/**
 * Metadata for the test process under `WORKTREE_CONTROL*` names. The same values are also set under
 * the pre-rename `WORKTREE_SWITCHER*` names so existing project scripts keep working.
 */
function controllerMetadata(project: Project, worktree: Worktree, profile: TestEnvironmentProfile): Record<string, string> {
  const scheme = project.tlsMode === "off" ? "http" : "https";
  const values: Record<string, string> = {
    "": "1",
    _PROJECT_ID: project.id,
    _TEST_PROFILE: profile.name,
    _WORKTREE_PATH: worktree.path,
    _SERVER_PORT: String(project.port),
    _SERVER_URL: `${scheme}://127.0.0.1:${project.port}`,
  };
  return Object.fromEntries(Object.entries(values).flatMap(([suffix, value]) => [
    [`WORKTREE_CONTROL${suffix}`, value],
    [`WORKTREE_SWITCHER${suffix}`, value],
  ]));
}

export const BUILT_IN_TEST_PROFILES: TestEnvironmentProfile[] = [
  { name: "unit", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: "test", requiredVariables: [] },
  { name: "tooling", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: null, requiredVariables: [] },
];

const UNIT_SCRIPTS = new Set(["test", "test:unit"]);

/**
 * Presets are mapped to the strictest useful profile until a human assigns one
 * explicitly. Only plain unit scripts get NODE_ENV=test; build or lint presets
 * must not be forced into a test runtime mode.
 */
export function defaultTestProfileName(preset: TestPreset): string {
  if (preset.adapter === "django") return "unit";
  return UNIT_SCRIPTS.has(preset.name) ? "unit" : "tooling";
}
