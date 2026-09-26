import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminRequestError, listenAdminSocket, requestAdminSocket } from "./admin-socket";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "ws-admin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("admin socket", () => {
  it("is reachable only through an owner-only socket and replaces a stale one", async () => {
    const root = directory();
    const path = join(root, "state", "admin.sock");
    const first = await listenAdminSocket(path, (body) => ({ echo: body }));
    // Simulate a crashed controller: the socket file stays behind without a listener.
    await new Promise<void>((resolve) => first.server.close(() => resolve()));

    const admin = await listenAdminSocket(path, (body) => {
      if ((body as { fail?: boolean }).fail) throw Object.assign(new Error("Refused."), { code: "auth_mode_unavailable" });
      return { echo: body };
    });
    cleanups.push(() => admin.close());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(await requestAdminSocket(path, { command: "status" })).toEqual({ echo: { command: "status" } });
    await expect(requestAdminSocket(path, { fail: true })).rejects.toEqual(new AdminRequestError("auth_mode_unavailable", "Refused."));
  });

  it("refuses to replace a regular file at the socket path", async () => {
    const path = join(directory(), "admin.sock");
    writeFileSync(path, "not a socket");
    await expect(listenAdminSocket(path, () => null)).rejects.toThrow("Refusing to replace non-socket file");
  });
});
