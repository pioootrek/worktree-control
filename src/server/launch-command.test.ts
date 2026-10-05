import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectLaunchCommandResolver } from "./launch-command";

const directories: string[] = [];

function fixture(packageJson: object, lockfile?: string, angular = false): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-command-"));
  directories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
  if (lockfile) writeFileSync(join(directory, lockfile), "");
  if (angular) writeFileSync(join(directory, "angular.json"), JSON.stringify({ version: 1, projects: {} }));
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProjectLaunchCommandResolver", () => {
  it("uses PORT for Next.js and honors the declared package manager", () => {
    const directory = fixture({
      packageManager: "pnpm@11.5.2",
      scripts: { dev: "next dev --turbopack" },
      dependencies: { next: "16.2.11" },
    });

    expect(new ProjectLaunchCommandResolver().resolve(directory, 3000)).toEqual({
      preset: "node",
      executable: "pnpm",
      args: ["run", "dev"],
      portMethod: "environment",
      tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    });
  });

  it("passes --port to a Vite script using npm forwarding syntax", () => {
    const directory = fixture({ scripts: { dev: "vite" }, devDependencies: { vite: "8.0.0" } }, "package-lock.json");

    expect(new ProjectLaunchCommandResolver().resolve(directory, 4173)).toEqual({
      preset: "node",
      executable: "npm",
      args: ["run", "dev", "--", "--port", "4173"],
      portMethod: "argument",
      tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    });
  });

  it("runs a standard Angular start script with an explicit loopback host and stable port", () => {
    const directory = fixture({
      scripts: { start: "ng serve" },
      devDependencies: { "@angular/cli": "22.1.4" },
    }, "package-lock.json", true);

    expect(new ProjectLaunchCommandResolver().resolve(directory, 4201)).toEqual({
      preset: "node",
      executable: "npm",
      args: ["run", "start", "--", "--host", "127.0.0.1", "--port", "4201"],
      portMethod: "argument",
      tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    });
  });

  it("prefers an Angular dev script and forwards flags directly with pnpm", () => {
    const directory = fixture({
      packageManager: "pnpm@11.22.0",
      scripts: { dev: "ng serve", start: "ng serve --configuration production" },
      devDependencies: { "@angular/cli": "22.1.4" },
    }, "pnpm-lock.yaml", true);

    expect(new ProjectLaunchCommandResolver().resolve(directory, 4300).args).toEqual([
      "run", "dev", "--host", "127.0.0.1", "--port", "4300",
    ]);
  });

  it("rejects an Angular workspace without an ng serve script", () => {
    const directory = fixture({
      scripts: { start: "node server.js" },
      devDependencies: { "@angular/cli": "22.1.4" },
    }, undefined, true);
    expect(() => new ProjectLaunchCommandResolver().resolve(directory, 4200)).toThrow("ng serve");
  });

  it("preserves stable port forwarding when Angular CLI is hoisted without root angular.json", () => {
    const directory = fixture({
      scripts: { dev: "node server.js" },
      devDependencies: { "@angular/cli": "22.1.4" },
    });
    expect(new ProjectLaunchCommandResolver().resolve(directory, 4200).args).toEqual([
      "run", "dev", "--", "--port", "4200",
    ]);
  });

  it("keeps wrapped Angular dev scripts working with the previous port fallback", () => {
    const directory = fixture({
      packageManager: "pnpm@11.22.0",
      scripts: { dev: "concurrently \"ng serve\" \"json-server db.json\"" },
      devDependencies: { "@angular/cli": "22.1.4" },
    }, undefined, true);
    expect(new ProjectLaunchCommandResolver().resolve(directory, 4202).args).toEqual([
      "run", "dev", "--port", "4202",
    ]);
  });

  it("detects a package manager from its lockfile", () => {
    const directory = fixture({ scripts: { dev: "node server.js" } }, "yarn.lock");
    expect(new ProjectLaunchCommandResolver().resolve(directory, 4000).executable).toBe("yarn");
  });

  it("rejects projects without a dev script during registration", () => {
    const directory = fixture({ scripts: { build: "tsc" } });
    expect(() => new ProjectLaunchCommandResolver().resolve(directory, 4000)).toThrow("skryptu dev");
  });

  it("enables a generated Next.js certificate", () => {
    const directory = fixture({
      packageManager: "pnpm@11.5.2",
      scripts: { dev: "next dev" },
      dependencies: { next: "16.2.11" },
    });
    const command = new ProjectLaunchCommandResolver().resolve(directory, 3000, "node", {
      mode: "generated", keyPath: null, certPath: null, caPath: null,
    });
    expect(command.args).toEqual(["run", "dev", "--experimental-https"]);
    expect(command.tls.mode).toBe("generated");
  });

  it("passes canonical custom certificate paths to Next.js", () => {
    const directory = fixture({ scripts: { dev: "next dev" }, dependencies: { next: "16.2.11" } }, "package-lock.json");
    const keyPath = join(directory, "dev-key.pem");
    const certPath = join(directory, "dev-cert.pem");
    writeFileSync(keyPath, "key");
    writeFileSync(certPath, "cert");
    const command = new ProjectLaunchCommandResolver().resolve(directory, 3000, "node", {
      mode: "custom", keyPath, certPath, caPath: null,
    });
    expect(command.args).toEqual([
      "run", "dev", "--", "--experimental-https",
      "--experimental-https-key", keyPath,
      "--experimental-https-cert", certPath,
    ]);
  });

  it("does not guess HTTPS flags for a non-Next project", () => {
    const directory = fixture({ scripts: { dev: "vite" }, devDependencies: { vite: "8.0.0" } });
    expect(() => new ProjectLaunchCommandResolver().resolve(directory, 4173, "node", {
      mode: "generated", keyPath: null, certPath: null, caPath: null,
    })).toThrow("tylko dla Next.js");
  });

  it("runs Django with a worktree-local .venv interpreter", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-command-"));
    directories.push(directory);
    writeFileSync(join(directory, "manage.py"), "#!/usr/bin/env python3\n");
    const venv = join(directory, ".venv", "bin");
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, "python"), "", { mode: 0o755 });

    expect(new ProjectLaunchCommandResolver().resolve(directory, 8000)).toEqual({
      preset: "django",
      executable: "./.venv/bin/python",
      args: ["manage.py", "runserver", "127.0.0.1:8000"],
      portMethod: "argument",
      tls: { mode: "off", keyPath: null, certPath: null, caPath: null },
    });
  });

  it("falls back to venv and then python3 for Django", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-command-"));
    directories.push(directory);
    writeFileSync(join(directory, "manage.py"), "");
    expect(new ProjectLaunchCommandResolver().resolve(directory, 8001, "django").executable).toBe("python3");
    const venv = join(directory, "venv", "bin");
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, "python"), "", { mode: 0o755 });
    expect(new ProjectLaunchCommandResolver().resolve(directory, 8001, "django").executable).toBe("./venv/bin/python");
  });

  it("requires an explicit preset for a repository containing Node.js and Django", () => {
    const directory = fixture({ scripts: { dev: "next dev" }, dependencies: { next: "16.2.11" } });
    writeFileSync(join(directory, "manage.py"), "");
    expect(() => new ProjectLaunchCommandResolver().resolve(directory, 3000)).toThrow("Wybierz preset");
    expect(new ProjectLaunchCommandResolver().resolve(directory, 8000, "django").preset).toBe("django");
  });
});
