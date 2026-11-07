import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

import type { LaunchPreset } from "@/shared/contracts";
import type { GodotWebConfig } from "@/shared/contracts/godot-web";

export const NO_SERVER_MESSAGE = "Verification-only projects have no managed server (launch preset none).";
export const GODOT_WEB_TLS_MESSAGE = "Managed HTTPS is not supported for the godot-web preset.";

/** The bundled static server and the per-project generation directory it may read. */
export interface GodotWebServerLaunch {
  executable: string;
  args: string[];
  publicDirectory(projectId: string): string;
}

export interface LaunchContext {
  projectId?: string;
  godotWeb?: GodotWebConfig | null;
}

/** Opaque, path-free identity binding a served generation to the runtime's worktree. */
export function webWorktreeKey(worktreePath: string): string {
  return createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
}

function hasGodotProject(worktreePath: string): boolean {
  try {
    const root = realpathSync(worktreePath);
    const file = realpathSync(join(root, "project.godot"));
    const path = relative(root, file);
    return !path.startsWith("..") && !isAbsolute(path) && statSync(file).isFile();
  } catch { return false; }
}

export interface LaunchCommand {
  preset: Exclude<LaunchPreset, "auto">;
  executable: string;
  args: string[];
  portMethod: "environment" | "argument" | "none";
  tls: NextTlsConfiguration;
}

export interface NextTlsConfiguration {
  mode: "off" | "generated" | "custom";
  keyPath: string | null;
  certPath: string | null;
  caPath: string | null;
}

export interface LaunchCommandResolver {
  resolve(worktreePath: string, port: number, preset?: LaunchPreset, tls?: NextTlsConfiguration, context?: LaunchContext): LaunchCommand;
}

type PackageJson = {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type NodePackageManager = typeof PACKAGE_MANAGERS[number];
const PORT_ARGUMENT_PACKAGES = ["vite", "astro", "nuxt", "@angular/cli"];

function isPackageManager(value: string): value is NodePackageManager {
  return PACKAGE_MANAGERS.some((manager) => manager === value);
}

export function detectPackageManager(worktreePath: string, packageJson: Pick<PackageJson, "packageManager">): NodePackageManager {
  if (typeof packageJson.packageManager === "string") {
    const declared = packageJson.packageManager.split("@", 1)[0];
    if (isPackageManager(declared)) return declared;
  }

  const lockfiles: Array<[NodePackageManager, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
    ["npm", "package-lock.json"],
  ];
  return lockfiles.find(([, filename]) => existsSync(join(worktreePath, filename)))?.[0] ?? "npm";
}

function usesPortArgument(packageJson: PackageJson): boolean {
  const packages = { ...packageJson.dependencies, ...packageJson.devDependencies };
  return PORT_ARGUMENT_PACKAGES.some((name) => name in packages);
}

function angularWorkspace(worktreePath: string, packageJson: PackageJson): boolean {
  const configurationPath = join(worktreePath, "angular.json");
  if (!existsSync(configurationPath) || !statSync(configurationPath).isFile()) return false;
  const packages = { ...packageJson.dependencies, ...packageJson.devDependencies };
  return "@angular/cli" in packages;
}

function angularServeScript(value: unknown): value is string {
  return typeof value === "string" && /(?:^|[;&|]\s*|\s)ng\s+(?:serve|dev|s)(?:\s|$)/.test(value);
}

function forwardedArgs(manager: LaunchCommand["executable"], args: string[]): string[] {
  return manager === "npm" && args.length > 0 ? ["--", ...args] : args;
}

function canonicalFile(path: string | null, label: string, required: boolean): string | null {
  if (!path) {
    if (required) throw new Error(`Wskaż plik: ${label}.`);
    return null;
  }
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isFile()) throw new Error();
    return canonical;
  } catch {
    throw new Error(`Nie można odczytać pliku ${label}: ${path}`);
  }
}

function resolveTls(packageJson: PackageJson, input: NextTlsConfiguration): NextTlsConfiguration {
  const packages = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (input.mode !== "off" && !("next" in packages)) {
    throw new Error("HTTPS zarządzany przez Worktree Control jest obecnie obsługiwany tylko dla Next.js.");
  }
  if (input.mode !== "custom") return { mode: input.mode, keyPath: null, certPath: null, caPath: null };
  return {
    mode: "custom",
    keyPath: canonicalFile(input.keyPath, "klucz prywatny", true),
    certPath: canonicalFile(input.certPath, "certyfikat", true),
    caPath: canonicalFile(input.caPath, "CA", false),
  };
}

function tlsArgs(tls: NextTlsConfiguration): string[] {
  if (tls.mode === "off") return [];
  if (tls.mode === "generated") return ["--experimental-https"];
  return [
    "--experimental-https",
    "--experimental-https-key", tls.keyPath!,
    "--experimental-https-cert", tls.certPath!,
    ...(tls.caPath ? ["--experimental-https-ca", tls.caPath] : []),
  ];
}

function djangoPython(worktreePath: string): string {
  for (const candidate of [".venv/bin/python", "venv/bin/python"]) {
    const absolute = join(worktreePath, candidate);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    try {
      accessSync(absolute, constants.X_OK);
      return `./${candidate}`;
    } catch {
      // Ignore incomplete virtual environments and continue to the next interpreter.
    }
  }
  return "python3";
}

export function detectLaunchPreset(worktreePath: string): Exclude<LaunchPreset, "auto"> {
  const hasNode = existsSync(join(worktreePath, "package.json"));
  const managePyPath = join(worktreePath, "manage.py");
  const hasDjango = existsSync(managePyPath) && statSync(managePyPath).isFile();
  if (hasNode && hasDjango) {
    throw new Error("Repozytorium zawiera package.json i manage.py. Wybierz preset Node.js albo Django.");
  }
  const godotPath = join(worktreePath, "project.godot");
  const hasGodot = existsSync(godotPath) && statSync(godotPath).isFile();
  const preset = hasNode ? "node" : hasDjango ? "django" : hasGodot ? "none" : null;
  if (!preset) throw new Error("Nie wykryto obsługiwanego projektu. Oczekiwano package.json albo manage.py.");
  return preset;
}

export class ProjectLaunchCommandResolver implements LaunchCommandResolver {
  constructor(private readonly godotWebServer?: GodotWebServerLaunch) {}

  resolve(
    worktreePath: string,
    port: number,
    preset: LaunchPreset = "auto",
    tlsInput: NextTlsConfiguration = { mode: "off", keyPath: null, certPath: null, caPath: null },
    context: LaunchContext = {},
  ): LaunchCommand {
    const packageJsonPath = join(worktreePath, "package.json");
    const managePyPath = join(worktreePath, "manage.py");
    const resolvedPreset = preset === "auto" ? detectLaunchPreset(worktreePath) : preset;

    if (resolvedPreset === "none") {
      if (tlsInput.mode !== "off") throw new Error(NO_SERVER_MESSAGE);
      return { preset: "none", executable: "", args: [], portMethod: "none", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } };
    }

    if (resolvedPreset === "godot-web") return this.godotWeb(worktreePath, tlsInput, context);

    if (resolvedPreset === "django") {
      if (!existsSync(managePyPath) || !statSync(managePyPath).isFile()) throw new Error("Nie znaleziono manage.py w katalogu głównym worktree.");
      if (tlsInput.mode !== "off") throw new Error("HTTPS zarządzany przez Worktree Control jest obecnie obsługiwany tylko dla Next.js.");
      return {
        preset: "django",
        executable: djangoPython(worktreePath),
        args: ["manage.py", "runserver", `127.0.0.1:${port}`],
        portMethod: "argument",
        tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
      };
    }

    if (!existsSync(packageJsonPath)) throw new Error("Nie znaleziono package.json w katalogu głównym worktree.");

    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    } catch {
      throw new Error("Nie udało się odczytać package.json. Sprawdź, czy plik zawiera prawidłowy JSON.");
    }
    const isAngular = angularWorkspace(worktreePath, packageJson);
    const hasDevScript = typeof packageJson.scripts?.dev === "string";
    const directAngularDev = isAngular && angularServeScript(packageJson.scripts?.dev);
    const directAngularStart = isAngular && !hasDevScript && angularServeScript(packageJson.scripts?.start);
    const scriptName = hasDevScript ? "dev" : directAngularStart ? "start" : null;
    if (!scriptName && isAngular) throw new Error("Projekt Angular nie ma skryptu dev ani start uruchamiającego ng serve.");
    if (!scriptName) throw new Error("Projekt nie ma skryptu dev w package.json.");

    const executable = detectPackageManager(worktreePath, packageJson);
    const passPortAsArgument = isAngular || usesPortArgument(packageJson);
    const tls = resolveTls(packageJson, tlsInput);
    const devArgs = [
      ...(directAngularDev || directAngularStart ? ["--host", "127.0.0.1", "--port", String(port)]
        : passPortAsArgument ? ["--port", String(port)] : []),
      ...tlsArgs(tls),
    ];
    return {
      preset: "node",
      executable,
      args: ["run", scriptName, ...forwardedArgs(executable, devArgs)],
      portMethod: passPortAsArgument ? "argument" : "environment",
      tls,
    };
  }

  /** Explicit opt-in only: auto detection never resolves to godot-web. */
  private godotWeb(worktreePath: string, tlsInput: NextTlsConfiguration, context: LaunchContext): LaunchCommand {
    if (tlsInput.mode !== "off") throw new Error(GODOT_WEB_TLS_MESSAGE);
    if (!hasGodotProject(worktreePath)) throw new Error("The selected worktree has no project.godot at its root.");
    if (!this.godotWebServer) throw new Error("The Godot Web runtime is unavailable in this controller mode.");
    const config = context.godotWeb;
    const args = [...this.godotWebServer.args];
    // Registration happens before the project ID exists; every start re-resolves with it.
    if (context.projectId) args.push("--root", this.godotWebServer.publicDirectory(context.projectId));
    args.push("--worktree-key", webWorktreeKey(worktreePath),
      "--live-reload", config?.liveReload === false ? "0" : "1",
      "--isolation", config?.crossOriginIsolation === false ? "0" : "1");
    return {
      preset: "godot-web", executable: this.godotWebServer.executable, args, portMethod: "environment",
      tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    };
  }
}

/** @deprecated Use ProjectLaunchCommandResolver. */
export class NodeLaunchCommandResolver extends ProjectLaunchCommandResolver {}
