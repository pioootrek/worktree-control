import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

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

const GODOT_PRESETS = ["check", "export-macos"];
const GODOT_MANIFEST = "scripts/worktree-control-presets.json";
const GODOT_MANIFEST_MAX_BYTES = 16 * 1024;
type GodotManifestReason = "io_error" | "outside_worktree" | "not_regular_file" | "too_large" | "invalid_utf8" | "invalid_json" | "invalid_schema";

class GodotManifestError extends Error {
  constructor(reason: GodotManifestReason) {
    super(`Nie można wczytać ${GODOT_MANIFEST} (${reason}).`);
  }
}

const godotManifestSchema = z.object({
  version: z.literal(1),
  godot: z.object({
    presets: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}(?![\s\S])/)
      .refine((name) => !GODOT_PRESETS.includes(name))).max(16)
      .refine((names) => new Set(names).size === names.length),
  }).strict(),
}).strict();

function additionalGodotPresets(worktreePath: string): string[] {
  const path = join(worktreePath, GODOT_MANIFEST);
  // Only an absent directory entry means no configuration. A dangling link,
  // unreadable file or invalid document must not silently restore defaults.
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new GodotManifestError("io_error");
  }
  let descriptor: number | undefined;
  try {
    const root = realpathSync(worktreePath);
    const file = realpathSync(path);
    const localPath = relative(root, file);
    if (localPath === ".." || localPath.startsWith("../") || isAbsolute(localPath)) throw new GodotManifestError("outside_worktree");
    if (!statSync(file).isFile()) throw new GodotManifestError("not_regular_file");
    // NONBLOCK avoids hanging if the file is replaced by a FIFO before open;
    // NOFOLLOW prevents following a replacement of the resolved final entry.
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new GodotManifestError("not_regular_file");
    if (stat.size > GODOT_MANIFEST_MAX_BYTES) throw new GodotManifestError("too_large");
    // Bound the read even when the file grows after fstat.
    const buffer = Buffer.alloc(GODOT_MANIFEST_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > GODOT_MANIFEST_MAX_BYTES) throw new GodotManifestError("too_large");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new GodotManifestError("invalid_utf8"); }
    let document: unknown;
    try { document = JSON.parse(text); }
    catch { throw new GodotManifestError("invalid_json"); }
    const parsed = godotManifestSchema.safeParse(document);
    if (!parsed.success) throw new GodotManifestError("invalid_schema");
    return parsed.data.godot.presets;
  } catch (error) {
    if (error instanceof GodotManifestError) throw error;
    throw new GodotManifestError("io_error");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class GodotTestCommandAdapter implements TestCommandAdapter {
  readonly kind = "godot" as const;

  discover(worktreePath: string): TestPreset[] {
    if (!worktreeFile(worktreePath, "project.godot") || !worktreeFile(worktreePath, "scripts/project.sh")) return [];
    return [...GODOT_PRESETS, ...additionalGodotPresets(worktreePath)]
      .map((name) => ({ id: `godot:${name}`, name, adapter: this.kind, timeoutMs: 15 * 60_000 }));
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
