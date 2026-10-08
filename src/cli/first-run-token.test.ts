import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireControllerLock } from "../server/controller-lock";
import { FileLogWriter } from "../server/log-writer";
import { AuthenticationService } from "../server/modules/authentication";
import { resolveAppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { runAuthCommand } from "./auth-management";
import { bootstrapInstallationToken, bootstrapServiceInstallationToken, FirstRunTokenRefusedError, type FirstRunTerminal } from "./first-run-token";

const TOKEN = /wsi_[0-9a-f-]{36}_[0-9a-f]{64}/g;
const directories: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "worktree-control-first-run-"));
  directories.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}

function terminal(isTTY: boolean): FirstRunTerminal & { output: string[] } {
  const output: string[] = [];
  return { isTTY, output, write: (chunk: string) => output.push(chunk) };
}

function withStore<T>(databasePath: string, operation: (authentication: AuthenticationService, store: SqliteStateStore) => T): T {
  const store = new SqliteStateStore(databasePath);
  try {
    return operation(new AuthenticationService(store), store);
  } finally {
    store.close();
  }
}

function persisted(databasePath: string): { settings: string; audit: Array<{ event_type: string; actor: string }> } {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      settings: JSON.stringify(database.prepare("SELECT * FROM controller_settings").all()),
      audit: database.prepare("SELECT event_type, actor, details_json FROM controller_audit_events ORDER BY id").all() as Array<{ event_type: string; actor: string }>,
    };
  } finally {
    database.close();
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("first-run installation token", () => {
  it("issues the token once on an interactive terminal through the auth token generate path", () => {
    const appPaths = paths();
    const tty = terminal(true);
    const token = withStore(appPaths.databasePath, (authentication) => {
      expect(authentication.status()).toEqual({ mode: "token", token: null, generation: 0 });
      expect(bootstrapInstallationToken(authentication, { terminal: tty, locale: "en" })).toBe(true);
      expect(tty.output).toHaveLength(1);
      const printed = tty.output[0]!.match(TOKEN) ?? [];
      expect(printed).toHaveLength(1);
      expect(tty.output[0]).toContain("Save it in a password manager now; it is not shown again");
      expect(tty.output[0]).toContain("auth token rotate");
      // The controller can now pass its startup policy and authenticate with the printed token.
      expect(authentication.assertStartupPolicy()).toMatchObject({ mode: "token", generation: 1 });
      expect(authentication.authenticateInstallation(printed[0]!)).toMatchObject({ authenticationMethod: "installation_token" });

      expect(bootstrapInstallationToken(authentication, { terminal: tty, locale: "en" })).toBe(false);
      expect(tty.output).toHaveLength(1);
      return printed[0]!;
    });

    const stored = persisted(appPaths.databasePath);
    expect(stored.settings).not.toContain(token.split("_").at(-1));
    expect(stored.audit).toEqual([expect.objectContaining({ event_type: "authentication.token_generated", actor: "local-cli" })]);
  });

  it("matches the persisted state of auth token generate", async () => {
    const bootstrapped = paths();
    const generated = paths();
    withStore(bootstrapped.databasePath, (authentication) => bootstrapInstallationToken(authentication, { terminal: terminal(true), locale: "en" }));
    await runAuthCommand(["token", "generate"], generated, { write: () => {} });
    const shape = (path: string) => {
      const { audit } = persisted(path);
      return { audit: audit.map(({ event_type, actor }) => ({ event_type, actor })), status: withStore(path, (authentication) => authentication.status()) };
    };
    const left = shape(bootstrapped.databasePath), right = shape(generated.databasePath);
    expect(left.audit).toEqual(right.audit);
    expect({ ...left.status, token: null }).toEqual({ ...right.status, token: null });
  });

  it("refuses without issuing when the output is not an interactive terminal or the controller runs as a service", () => {
    const appPaths = paths();
    for (const options of [{ terminal: terminal(false) }, { terminal: terminal(true), serviceMode: true }, { terminal: { write: () => {} } }]) {
      withStore(appPaths.databasePath, (authentication) => {
        const call = () => bootstrapInstallationToken(authentication, { ...options, locale: "en" });
        expect(call).toThrow(FirstRunTokenRefusedError);
        expect(call).toThrow("worktree-control auth token generate");
        expect(authentication.status()).toEqual({ mode: "token", token: null, generation: 0 });
      });
      if ("output" in options.terminal) expect(options.terminal.output).toEqual([]);
    }
    expect(persisted(appPaths.databasePath).audit).toEqual([]);
  });

  it("leaves installations that do not need a token unchanged", async () => {
    const withToken = paths();
    await runAuthCommand(["token", "generate"], withToken, { write: () => {} });
    const open = paths();
    await runAuthCommand(["mode", "set", "open"], open, { write: () => {} });
    for (const appPaths of [withToken, open]) {
      const tty = terminal(true);
      const before = withStore(appPaths.databasePath, (authentication) => authentication.status());
      withStore(appPaths.databasePath, (authentication) => {
        expect(bootstrapInstallationToken(authentication, { terminal: tty, locale: "en" })).toBe(false);
        expect(bootstrapInstallationToken(authentication, { terminal: terminal(false), locale: "en", serviceMode: true })).toBe(false);
        expect(authentication.status()).toEqual(before);
      });
      expect(tty.output).toEqual([]);
    }
  });

  it("writes the token only to the terminal, never to process output streams or controller logs", async () => {
    const appPaths = paths();
    const captured: string[] = [];
    const capture = (chunk: unknown) => { captured.push(String(chunk)); return true; };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...values) => { captured.push(values.join(" ")); });
    const logs = new FileLogWriter(appPaths.logDirectory);
    const tty = terminal(true);
    try {
      withStore(appPaths.databasePath, (authentication) => {
        expect(bootstrapInstallationToken(authentication, { terminal: tty, locale: "en" })).toBe(true);
        logs.controller("authentication.status", { status: authentication.status() });
      });
    } finally {
      await logs.close();
    }
    const token = tty.output.join("").match(TOKEN)![0];
    const secret = token.split("_").at(-1)!;
    expect(captured.join("\n")).not.toContain(secret);
    const logFiles = filesUnder(appPaths.logDirectory).filter((path) => statSync(path).isFile());
    expect(logFiles.length).toBeGreaterThan(0);
    for (const path of logFiles) expect(readFileSync(path, "utf8")).not.toContain(secret);
  });

  it("prints the Polish warning for a Polish locale", () => {
    const tty = terminal(true);
    withStore(paths().databasePath, (authentication) => bootstrapInstallationToken(authentication, { terminal: tty, locale: "pl" }));
    expect(tty.output[0]).toContain("nie zostanie pokazany ponownie");
  });
});

describe("service install first-run token", () => {
  it("issues the token offline before installation and only once", () => {
    const appPaths = paths();
    const tty = terminal(true);
    expect(bootstrapServiceInstallationToken(appPaths, { terminal: tty, locale: "en" })).toBe(true);
    expect(bootstrapServiceInstallationToken(appPaths, { terminal: tty, locale: "en" })).toBe(false);
    expect(tty.output).toHaveLength(1);
    expect(tty.output[0]!.match(TOKEN)).toHaveLength(1);
    // The lock is released for the service that starts next.
    acquireControllerLock(appPaths.controllerLockPath).release();
    expect(withStore(appPaths.databasePath, (authentication) => authentication.assertStartupPolicy().generation)).toBe(1);
  });

  it("refuses the installation on a non-interactive terminal and keeps the token missing", () => {
    const appPaths = paths();
    const pipe = terminal(false);
    expect(() => bootstrapServiceInstallationToken(appPaths, { terminal: pipe, locale: "en" })).toThrow("worktree-control auth token generate");
    expect(pipe.output).toEqual([]);
    acquireControllerLock(appPaths.controllerLockPath).release();
    expect(withStore(appPaths.databasePath, (authentication) => authentication.status().token)).toBeNull();
  });

  it("leaves a running controller and a database awaiting migration to the controller", () => {
    const running = paths();
    const lock = acquireControllerLock(running.controllerLockPath);
    const tty = terminal(true);
    try {
      expect(bootstrapServiceInstallationToken(running, { terminal: tty, locale: "en" })).toBe(false);
    } finally {
      lock.release();
    }

    const pending = paths();
    mkdirSync(pending.dataDirectory, { recursive: true, mode: 0o700 });
    const database = new Database(pending.databasePath);
    database.exec(readFileSync(new URL("../server/infrastructure/sqlite/fixtures/schema-v26.sql", import.meta.url), "utf8"));
    database.close();
    expect(bootstrapServiceInstallationToken(pending, { terminal: tty, locale: "en" })).toBe(false);
    const inspected = new Database(pending.databasePath, { readonly: true });
    try {
      expect((inspected.prepare("SELECT max(version) version FROM schema_migrations").get() as { version: number }).version).toBe(26);
    } finally {
      inspected.close();
    }
    expect(tty.output).toEqual([]);
  });
});
