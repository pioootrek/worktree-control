import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { GodotWebConfig } from "@/shared/contracts/godot-web";

export type GodotWebConfigurationCode =
  | "missing_project_godot" | "missing_export_presets" | "export_preset_not_found" | "export_preset_not_web"
  | "godot_executable_unavailable" | "export_script_unavailable" | "output_directory_invalid";

/** Safe, path-free configuration failure shared by HTTP, MCP and CLI. */
export class GodotWebConfigurationError extends Error {
  constructor(readonly code: GodotWebConfigurationCode, message: string) { super(message); }
}

export interface ResolvedWebExport {
  executable: string;
  args: string[];
  cwd: string;
  /** Absolute directory the completed export is read from. */
  outputDirectory: string;
  /** Worktree-relative paths the watcher must ignore because the exporter writes them. */
  generatedPaths: string[];
}

const MAX_PRESETS_BYTES = 1024 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves a worktree file without following a symlink out of the worktree. */
export function worktreeFile(worktreePath: string, relativePath: string): string | null {
  try {
    const root = realpathSync(worktreePath);
    const file = realpathSync(join(root, relativePath));
    return inside(root, file) && statSync(file).isFile() ? file : null;
  } catch { return null; }
}

export function assertGodotProject(worktreePath: string): void {
  if (!worktreeFile(worktreePath, "project.godot")) {
    throw new GodotWebConfigurationError("missing_project_godot", "The selected worktree has no project.godot at its root.");
  }
}

interface ExportPresetSection { name: string; platform: string; threads: boolean }

/** Minimal reader of Godot's export_presets.cfg [preset.N] sections; options sections are ignored. */
export function readExportPresets(text: string): ExportPresetSection[] {
  const presets: ExportPresetSection[] = [];
  let current: ExportPresetSection | null = null;
  let options: ExportPresetSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\[preset\.(\d+)(\.options)?\]\s*$/);
    if (section) {
      if (section[2]) { options = presets[Number(section[1])] ?? null; current = null; }
      else { current = { name: "", platform: "", threads: false }; presets[Number(section[1])] = current; options = null; }
      continue;
    }
    if (line.startsWith("[")) { current = null; options = null; continue; }
    const value = line.match(/^([A-Za-z0-9_/]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (current && value?.[1] === "name") current.name = value[2];
    if (current && value?.[1] === "platform") current.platform = value[2];
    if (options && /^variant\/thread_support\s*=\s*true\s*$/.test(line)) options.threads = true;
  }
  return presets.filter(Boolean);
}

function presetExport(config: Extract<GodotWebConfig["exporter"], { kind: "preset" }>, worktreePath: string, stagingDirectory: string): ResolvedWebExport {
  const presetsPath = worktreeFile(worktreePath, "export_presets.cfg");
  if (!presetsPath) throw new GodotWebConfigurationError("missing_export_presets", "The worktree has no export_presets.cfg. Create a Web export preset in the Godot editor first.");
  if (statSync(presetsPath).size > MAX_PRESETS_BYTES) throw new GodotWebConfigurationError("missing_export_presets", "export_presets.cfg is too large to inspect.");
  const preset = readExportPresets(readFileSync(presetsPath, "utf8")).find(({ name }) => name === config.preset);
  if (!preset) throw new GodotWebConfigurationError("export_preset_not_found", `Export preset "${config.preset}" does not exist in export_presets.cfg.`);
  if (preset.platform !== "Web") throw new GodotWebConfigurationError("export_preset_not_web", `Export preset "${config.preset}" targets ${preset.platform || "an unknown platform"}, not Web.`);
  if (isAbsolute(config.godotExecutable)) {
    try { accessSync(config.godotExecutable, constants.X_OK); if (!statSync(config.godotExecutable).isFile()) throw new Error(); }
    catch { throw new GodotWebConfigurationError("godot_executable_unavailable", "The configured Godot executable is missing or not executable."); }
  }
  const root = realpathSync(worktreePath);
  return {
    executable: config.godotExecutable,
    // Godot 4 export implies resource import; templates must match the engine version.
    args: ["--headless", "--path", root, "--export-release", config.preset, join(stagingDirectory, "index.html")],
    cwd: root,
    outputDirectory: stagingDirectory,
    generatedPaths: [],
  };
}

function commandExport(config: Extract<GodotWebConfig["exporter"], { kind: "command" }>, worktreePath: string): ResolvedWebExport {
  const root = realpathSync(worktreePath);
  const [program, ...args] = config.command;
  let executable = program;
  if (program.includes("/")) {
    const relativeProgram = program.replace(/^\.\//, "");
    const script = worktreeFile(root, relativeProgram);
    if (!script) throw new GodotWebConfigurationError("export_script_unavailable", "The export command script is missing or leaves the worktree.");
    try { accessSync(script, constants.X_OK); }
    catch { throw new GodotWebConfigurationError("export_script_unavailable", "The export command script is not executable; run it through an interpreter such as bash."); }
    executable = `./${relativeProgram}`;
  }
  // Reject a symlinked or escaping output directory early; publication revalidates it.
  const output = join(root, config.outputDirectory);
  try {
    const info = lstatSync(output);
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(root, realpathSync(output))) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GodotWebConfigurationError("output_directory_invalid", "The export output directory must be a real directory inside the worktree.");
    }
  }
  return { executable, args, cwd: root, outputDirectory: output, generatedPaths: [config.outputDirectory] };
}

/** Validates prerequisites and returns a shell-free command. Nothing is installed or upgraded. */
export function resolveWebExport(config: GodotWebConfig, worktreePath: string, stagingDirectory: string): ResolvedWebExport {
  assertGodotProject(worktreePath);
  return config.exporter.kind === "preset"
    ? presetExport(config.exporter, worktreePath, stagingDirectory)
    : commandExport(config.exporter, worktreePath);
}

/** Thread-enabled Web presets need cross-origin isolation and a secure context. */
export function presetUsesThreads(config: GodotWebConfig, worktreePath: string): boolean {
  if (config.exporter.kind !== "preset") return false;
  const presetsPath = worktreeFile(worktreePath, "export_presets.cfg");
  if (!presetsPath || statSync(presetsPath).size > MAX_PRESETS_BYTES) return false;
  const name = config.exporter.preset;
  return readExportPresets(readFileSync(presetsPath, "utf8")).some((preset) => preset.name === name && preset.threads);
}
