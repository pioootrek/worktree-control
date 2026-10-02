import type { IncomingMessage } from "node:http";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { UserBackupError, type UserSchedules } from "@/server/modules/backups";
import { userScheduleCommandSchema } from "@/shared/contracts/user-backups";

export async function handleUserBackupHttp(request: IncomingMessage, actor: AuthenticatedPrincipal | null, schedules: UserSchedules, readJson: (request: IncomingMessage) => Promise<unknown>, reply: (status: number, body: unknown) => void): Promise<void> {
  try {
    if (!actor) throw new UserBackupError("forbidden", 403);
    if (request.method === "GET") { reply(200, schedules.overview(actor)); return; }
    if (request.method !== "POST") { reply(405, { code: "invalid" }); return; }
    const parsed = userScheduleCommandSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new UserBackupError("invalid");
    reply(200, schedules.command(actor, parsed.data));
  } catch (error) {
    const failure = error instanceof UserBackupError ? error : new UserBackupError("failed", 503);
    reply(failure.status, { code: failure.code, error: failure.code });
  }
}
