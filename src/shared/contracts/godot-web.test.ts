import { describe, expect, it } from "vitest";

import { DEFAULT_GODOT_WEB_CONFIG, isSafeRelativePath, parseGodotWebConfig } from "./godot-web";

describe("Godot Web configuration contract", () => {
  it("defaults to the standard Web preset with bounded watching and live reload", () => {
    expect(DEFAULT_GODOT_WEB_CONFIG).toEqual({
      version: 1,
      exporter: { kind: "preset", preset: "Web", godotExecutable: "godot" },
      watch: { paths: ["."], ignore: [], debounceMs: 750 },
      liveReload: true,
      crossOriginIsolation: true,
    });
  });

  it("accepts the project-command pattern with a worktree output directory", () => {
    const config = parseGodotWebConfig({
      exporter: { kind: "command", command: ["bash", "scripts/project.sh", "export-playable-web"], outputDirectory: "exports/playable-web/" },
      watch: { paths: ["game", "scenes", "project.godot"], ignore: ["analysis-local"] },
      liveReload: false,
    });
    expect(config.exporter).toEqual({ kind: "command", command: ["bash", "scripts/project.sh", "export-playable-web"], outputDirectory: "exports/playable-web" });
    expect(config.watch).toEqual({ paths: ["game", "scenes", "project.godot"], ignore: ["analysis-local"], debounceMs: 750 });
  });

  it.each([
    ["../outside"], ["/abs/path"], ["a/../../b"], [".git/hooks"], ["a\\b"], ["."], ["a//b"], ["x\u0000y"],
  ])("rejects unsafe output directory %j", (outputDirectory) => {
    expect(() => parseGodotWebConfig({ exporter: { kind: "command", command: ["bash", "x.sh"], outputDirectory } })).toThrow(/Invalid Godot Web configuration \(exporter\.outputDirectory\)/);
  });

  it("rejects absolute or traversing command programs, unknown fields and multi-line arguments", () => {
    for (const command of [["/bin/sh", "-c", "x"], ["../escape.sh"], ["sh -c"], []]) {
      expect(() => parseGodotWebConfig({ exporter: { kind: "command", command, outputDirectory: "out" } })).toThrow(/Invalid Godot Web configuration/);
    }
    expect(() => parseGodotWebConfig({ exporter: { kind: "command", command: ["bash", "a\nb"], outputDirectory: "out" } })).toThrow(/command/);
    expect(() => parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" }, extra: true })).toThrow(/Invalid Godot Web configuration/);
    expect(() => parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web", godotExecutable: "../godot" } })).toThrow(/godotExecutable/);
    expect(() => parseGodotWebConfig({ exporter: { kind: "preset", preset: "Web" }, watch: { paths: ["."], debounceMs: 20 } })).toThrow(/debounceMs/);
  });

  it("allows the root only for watched paths", () => {
    expect(isSafeRelativePath(".", true)).toBe(true);
    expect(isSafeRelativePath(".", false)).toBe(false);
    expect(isSafeRelativePath(".godot")).toBe(true);
    expect(isSafeRelativePath("..")).toBe(false);
  });
});
