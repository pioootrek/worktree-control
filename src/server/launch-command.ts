import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import type { LaunchPreset } from "@/shared/contracts";

export interface LaunchCommand {
  preset: Exclude<LaunchPreset, "auto">;
  executable: string;
  args: string[];
  portMethod: "environment" | "argument";
  tls: NextTlsConfiguration;
}

export interface NextTlsConfiguration {
  mode: "off" | "generated" | "custom";
  keyPath: string | null;
  certPath: string | null;
  caPath: string | null;
}

export interface LaunchCommandResolver {
  resolve(worktreePath: string, port: number, preset?: LaunchPreset, tls?: NextTlsConfiguration): LaunchCommand;
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

export class ProjectLaunchCommandResolver implements LaunchCommandResolver {
  resolve(
    worktreePath: string,
    port: number,
    preset: LaunchPreset = "auto",
    tlsInput: NextTlsConfiguration = { mode: "off", keyPath: null, certPath: null, caPath: null },
  ): LaunchCommand {
    const packageJsonPath = join(worktreePath, "package.json");
    const managePyPath = join(worktreePath, "manage.py");
    const hasNode = existsSync(packageJsonPath);
    const hasDjango = existsSync(managePyPath) && statSync(managePyPath).isFile();
    if (preset === "auto" && hasNode && hasDjango) {
      throw new Error("Repozytorium zawiera package.json i manage.py. Wybierz preset Node.js albo Django.");
    }
    const resolvedPreset = preset === "auto" ? (hasNode ? "node" : hasDjango ? "django" : null) : preset;
    if (!resolvedPreset) throw new Error("Nie wykryto obsługiwanego projektu. Oczekiwano package.json albo manage.py.");

    if (resolvedPreset === "django") {
      if (!hasDjango) throw new Error("Nie znaleziono manage.py w katalogu głównym worktree.");
      if (tlsInput.mode !== "off") throw new Error("HTTPS zarządzany przez Worktree Control jest obecnie obsługiwany tylko dla Next.js.");
      return {
        preset: "django",
        executable: djangoPython(worktreePath),
        args: ["manage.py", "runserver", `127.0.0.1:${port}`],
        portMethod: "argument",
        tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
      };
    }

    if (!hasNode) throw new Error("Nie znaleziono package.json w katalogu głównym worktree.");

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
}

/** @deprecated Use ProjectLaunchCommandResolver. */
export class NodeLaunchCommandResolver extends ProjectLaunchCommandResolver {}
