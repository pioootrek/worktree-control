import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { handleUserBackupHttp } from "./user-backup-http";
import { UserBackupError, type UserSchedules } from "@/server/modules/backups";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";

const actor: AuthenticatedPrincipal = { principalId: "owner", principalKind: "owner", credentialId: "credential", authenticationMethod: "owner_session" };
describe("user schedule HTTP boundary", () => {
  it("uses only the authenticated actor and rejects paths, owner and policy mutation", async () => {
    const overview = vi.fn(() => ({ schedules: [] })), command = vi.fn();
    const service = { overview, command } as unknown as UserSchedules;
    const reply = vi.fn();
    await handleUserBackupHttp({ method: "GET" } as IncomingMessage, actor, service, async () => ({}), reply);
    expect(overview).toHaveBeenCalledWith(actor); expect(reply).toHaveBeenLastCalledWith(200, { schedules: [] });
    for (const body of [{ action: "policy", enabled: true }, { action: "save", ownerId: "other" }, { action: "artifact", path: "/etc/passwd" }]) {
      await handleUserBackupHttp({ method: "POST" } as IncomingMessage, actor, service, async () => body, reply);
      expect(reply).toHaveBeenLastCalledWith(400, { code: "invalid", error: "invalid" });
    }
    expect(command).not.toHaveBeenCalled();
  });
  it("does not invoke operations without an identity and reports safe denial", async () => {
    const overview = vi.fn(() => { throw new UserBackupError("forbidden", 403); });
    const service = { overview } as unknown as UserSchedules, reply = vi.fn();
    await handleUserBackupHttp({ method: "GET" } as IncomingMessage, null, service, async () => ({}), reply);
    expect(overview).not.toHaveBeenCalled(); expect(reply).toHaveBeenLastCalledWith(403, { code: "forbidden", error: "forbidden" });
    await handleUserBackupHttp({ method: "GET" } as IncomingMessage, actor, service, async () => ({}), reply);
    expect(reply).toHaveBeenLastCalledWith(403, { code: "forbidden", error: "forbidden" });
  });
});
