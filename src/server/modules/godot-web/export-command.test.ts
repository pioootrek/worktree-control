import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseGodotWebConfig } from "@/shared/contracts/godot-web";
import { GodotWebConfigurationError, presetUsesThreads, readExportPresets, resolveWebExport } from "./export-command";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function worktree(presets?: string): string {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-export-")); roots.push(root);
  writeFileSync(join(root, "project.godot"), "config_version=5\n");
  if (presets !== undefined) writeFileSync(join(root, "export_presets.cfg"), presets);
  return root;
}
const PRESETS = `[preset.0]

name="macOS"
platform="macOS"

[preset.1]

name="Web"
platform="Web"
export_path="build/index.html"

[preset.1.options]

variant/thread_support=true
`;

describe("Godot Web export command", () => {
  it("parses preset sections and thread support", () => {
    expect(readExportPresets(PRESETS)).toEqual([
      { name: "macOS", platform: "macOS", threads: false },
      { name: "Web", platform: "Web", threads: true },
    ]);
  });

  it("resolves a shell-free headless export into the controller staging directory", () => {
    const root = worktree(PRESETS);
    const resolved = resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" } }), root, "/state/staging");
    expect(resolved).toMatchObject({ executable: "godot", args: ["--headless", "--path", expect.any(String), "--export-release", "Web", "/state/staging/index.html"], outputDirectory: "/state/staging", generatedPaths: [] });
    expect(presetUsesThreads(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" } }), root)).toBe(true);
  });

  it("fails clearly for missing project, presets, wrong platform and executables", () => {
    const cases: Array<[string, () => void]> = [
      ["missing_project_godot", () => { const root = worktree(PRESETS); rmSync(join(root, "project.godot")); resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" } }), root, "/s"); }],
      ["missing_export_presets", () => resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" } }), worktree(), "/s")],
      ["export_preset_not_found", () => resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Missing" } }), worktree(PRESETS), "/s")],
      ["export_preset_not_web", () => resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "macOS" } }), worktree(PRESETS), "/s")],
      ["godot_executable_unavailable", () => resolveWebExport(parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web", godotExecutable: "/nonexistent/godot" } }), worktree(PRESETS), "/s")],
    ];
    for (const [code, run] of cases) {
      expect(run).toThrow(GodotWebConfigurationError);
      try { run(); } catch (error) { expect((error as GodotWebConfigurationError).code).toBe(code); }
    }
  });

  it("keeps project commands and output inside the worktree", () => {
    const root = worktree();
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/export.sh"), "#!/bin/sh\n");
    const command = (program: string, outputDirectory = "exports/web") =>
      resolveWebExport(parseGodotWebConfig({ exporter: { kind: "command", command: [program, "arg"], outputDirectory } }), root, "/s");
    expect(command("bash")).toMatchObject({ executable: "bash", args: ["arg"], generatedPaths: ["exports/web"] });
    expect(() => command("scripts/export.sh")).toThrow(/not executable/);
    chmodSync(join(root, "scripts/export.sh"), 0o755);
    expect(command("./scripts/export.sh").executable).toBe("./scripts/export.sh");
    const outside = mkdtempSync(join(tmpdir(), "wtc-godot-outside-")); roots.push(outside);
    symlinkSync(outside, join(root, "escape"));
    expect(() => command("bash", "escape")).toThrow(/real directory inside the worktree/);
    symlinkSync(join(outside, "x.sh"), join(root, "scripts/linked.sh"));
    expect(() => command("scripts/linked.sh")).toThrow(/missing or leaves the worktree/);
  });
});
