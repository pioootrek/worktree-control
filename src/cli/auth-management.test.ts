import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { listenAdminSocket } from "../server/admin-socket";
import { acquireControllerLock } from "../server/controller-lock";
import { resolveAppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { runAuthCommand } from "./auth-management";
import { authenticateOfflineActor } from "./offline-actor";

const directories: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "worktree-switcher-auth-cli-"));
  directories.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}

async function run(args: string[], appPaths: ReturnType<typeof paths>): Promise<Record<string, unknown>> {
  const output: string[] = [];
  await runAuthCommand(args, appPaths, { write: (line) => output.push(line) });
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("auth administration CLI", () => {
  it("reports status, emits the token once and rotates it without persisting the secret", async () => {
    const appPaths = paths();
    expect(await run(["status"], appPaths)).toEqual({ mode: "legacy", token: null, generation: 0 });

    const generated = await run(["token", "generate"], appPaths) as { token: string; status: { generation: number } };
    expect(generated.token).toMatch(/^wsi_[0-9a-f-]{36}_[0-9a-f]{64}$/);
    expect(generated.status.generation).toBe(1);
    await expect(runAuthCommand(["token", "generate"], appPaths)).rejects.toThrow("auth token rotate");

    const rotated = await run(["token", "rotate"], appPaths) as { token: string; status: { generation: number } };
    expect(rotated.token).not.toBe(generated.token);
    expect(rotated.status.generation).toBe(2);
    const status = await run(["status"], appPaths);
    expect(JSON.stringify(status)).not.toContain(rotated.token);

    const database = new Database(appPaths.databasePath, { readonly: true });
    const persisted = JSON.stringify(database.prepare("SELECT * FROM controller_settings").all())
      + JSON.stringify(database.prepare("SELECT * FROM controller_audit_events").all());
    database.close();
    for (const token of [generated.token, rotated.token]) expect(persisted).not.toContain(token.split("_").at(-1));
  });

  it("keeps the active mode when Better Auth or an unknown mode is requested", async () => {
    const appPaths = paths();
    await expect(runAuthCommand(["mode", "set", "better-auth"], appPaths)).rejects.toThrow("Better Auth: to be implemented soon.");
    await expect(runAuthCommand(["mode", "set", "legacy"], appPaths)).rejects.toThrow("Dostępne tryby");
    expect((await run(["status"], appPaths)).mode).toBe("legacy");
    expect((await run(["mode", "set", "open"], appPaths)).mode).toBe("open");
    await expect(runAuthCommand(["mode", "set", "better-auth"], appPaths)).rejects.toThrow("Better Auth: to be implemented soon.");
    expect((await run(["status"], appPaths)).mode).toBe("open");
  });

  it("rejects malformed commands before opening the database", async () => {
    const appPaths = paths();
    for (const args of [[], ["token"], ["token", "show"], ["mode", "set"], ["mode", "set", "token", "extra"], ["status", "now"]]) {
      await expect(runAuthCommand(args, appPaths)).rejects.toThrow("Available auth commands");
    }
  });

  it("never opens the database beside a running controller and uses its admin socket instead", async () => {
    const appPaths = paths();
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      await expect(runAuthCommand(["status"], appPaths)).rejects.toThrow("without an admin socket");
      const requests: unknown[] = [];
      const admin = await listenAdminSocket(appPaths.adminSocketPath, (body) => { requests.push(body); return { mode: "token" }; });
      try {
        expect(await run(["mode", "set", "token"], appPaths)).toEqual({ mode: "token" });
        expect(requests).toEqual([{ command: "mode set", value: "token" }]);
      } finally {
        await admin.close();
      }
    } finally {
      lock.release();
    }
  });

  it("selects token mode only after a token exists and then authenticates offline callers with it", async () => {
    const appPaths = paths();
    await expect(runAuthCommand(["mode", "set", "token"], appPaths)).rejects.toThrow("auth token generate");
    const { token } = await run(["token", "generate"], appPaths) as { token: string };

    let store = new SqliteStateStore(appPaths.databasePath);
    expect(() => authenticateOfflineActor(store, token)).toThrow("Nieprawidłowe lub nieaktywne poświadczenie.");
    store.close();

    expect((await run(["mode", "set", "token"], appPaths)).mode).toBe("token");
    store = new SqliteStateStore(appPaths.databasePath);
    try {
      expect(authenticateOfflineActor(store, token).actor).toMatchObject({ principalId: "installation", authenticationMethod: "installation_token" });
      expect(() => authenticateOfflineActor(store, "pairing")).toThrow("Nieprawidłowe lub nieaktywne poświadczenie.");
    } finally {
      store.close();
    }
  });
});
