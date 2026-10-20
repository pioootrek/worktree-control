import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { TestAdapterKind, TestPreset } from "@/shared/contracts";
import { detectPackageManager } from "./launch-command";

export interface TestCommand {
  preset: TestPreset;
  executable: string;
  args: string[];
  cwd: string;
}

export interface TestCommandAdapter {
  readonly kind: TestAdapterKind;
  discover(worktreePath: string): TestPreset[];
  resolve(worktreePath: string, presetId: string): TestCommand;
}

type PackageJson = {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
};

const NODE_SCRIPT = /^(?:test(?::[A-Za-z0-9._-]+)*|check|lint|typecheck|build)$/;
const WATCH_SCRIPT = /(?:^|:)(?:watch|dev)$/;

function packageJson(worktreePath: string): PackageJson | null {
  const path = join(worktreePath, "package.json");
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    throw new Error("Nie udało się odczytać package.json podczas wykrywania testów.");
  }
}

export class NodeTestCommandAdapter implements TestCommandAdapter {
  readonly kind = "node" as const;

  discover(worktreePath: string): TestPreset[] {
    const manifest = packageJson(worktreePath);
    if (!manifest) return [];
    return Object.entries(manifest.scripts ?? {})
      .filter(([name, value]) => typeof value === "string" && NODE_SCRIPT.test(name) && !WATCH_SCRIPT.test(name))
      .map(([name]) => ({ id: `node:${name}`, name, adapter: this.kind, timeoutMs: 15 * 60_000 }));
  }

  resolve(worktreePath: string, presetId: string): TestCommand {
    const preset = this.discover(worktreePath).find(({ id }) => id === presetId);
    if (!preset) throw new Error("Wybrany preset testowy Node.js nie istnieje już w tym worktree.");
    const manifest = packageJson(worktreePath)!;
    return { preset, executable: detectPackageManager(worktreePath, manifest), args: ["run", preset.name], cwd: worktreePath };
  }
}

function djangoPython(worktreePath: string): string {
  for (const candidate of [".venv/bin/python", "venv/bin/python"]) {
    const absolute = join(worktreePath, candidate);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    try {
      accessSync(absolute, constants.X_OK);
      return `./${candidate}`;
    } catch {
      // Continue to the next explicitly supported interpreter.
    }
  }
  return "python3";
}

export class DjangoTestCommandAdapter implements TestCommandAdapter {
  readonly kind = "django" as const;

  discover(worktreePath: string): TestPreset[] {
    const path = join(worktreePath, "manage.py");
    return existsSync(path) && statSync(path).isFile()
      ? [{ id: "django:test", name: "Django tests", adapter: this.kind, timeoutMs: 15 * 60_000 }]
      : [];
  }

  resolve(worktreePath: string, presetId: string): TestCommand {
    const preset = this.discover(worktreePath).find(({ id }) => id === presetId);
    if (!preset) throw new Error("Wybrany preset testowy Django nie istnieje już w tym worktree.");
    return { preset, executable: djangoPython(worktreePath), args: ["manage.py", "test"], cwd: worktreePath };
  }
}

function worktreeFile(worktreePath: string, filename: string): boolean {
  try {
    const root = realpathSync(worktreePath);
    const file = realpathSync(join(root, filename));
    const path = relative(root, file);
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path) && statSync(file).isFile();
  } catch { return false; }
}

export class GodotTestCommandAdapter implements TestCommandAdapter {
  readonly kind = "godot" as const;

  discover(worktreePath: string): TestPreset[] {
    if (!worktreeFile(worktreePath, "project.godot") || !worktreeFile(worktreePath, "scripts/project.sh")) return [];
    return ["check", "export-macos"].map((name) => ({ id: `godot:${name}`, name, adapter: this.kind, timeoutMs: 15 * 60_000 }));
  }

  resolve(worktreePath: string, presetId: string): TestCommand {
    const preset = this.discover(worktreePath).find(({ id }) => id === presetId);
    if (!preset) throw new Error("Wybrany preset testowy Godot nie istnieje już w tym worktree.");
    return { preset, executable: "bash", args: ["scripts/project.sh", preset.name], cwd: worktreePath };
  }
}

export class ProjectTestCommandResolver {
  constructor(private readonly adapters: TestCommandAdapter[] = [new NodeTestCommandAdapter(), new DjangoTestCommandAdapter(), new GodotTestCommandAdapter()]) {}

  discover(worktreePath: string): TestPreset[] {
    return this.adapters.flatMap((adapter) => adapter.discover(worktreePath));
  }

  resolve(worktreePath: string, presetId: string): TestCommand {
    const kind = presetId.split(":", 1)[0];
    const adapter = this.adapters.find((candidate) => candidate.kind === kind);
    if (!adapter) throw new Error("Nieobsługiwany adapter testów.");
    return adapter.resolve(worktreePath, presetId);
  }
}
