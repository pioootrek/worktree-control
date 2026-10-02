import type { IncomingMessage, ServerResponse } from "node:http";
import { backupCommandSchema } from "@/shared/contracts/backups";
import { BackupError, type BackupOperations, type RestoreOperations, type BackupActor } from "@/server/modules/backups";

/** Transport adapter: IDs and keys only; service policy has no mutation endpoint. */
export async function handleBackupHttp(request: IncomingMessage, response: ServerResponse, actor: BackupActor | null, backups: BackupOperations, restores: RestoreOperations, readJson: (request: IncomingMessage) => Promise<unknown>, reply: (status: number, body: unknown) => void): Promise<void> {
  try {
    if (!actor) throw new BackupError("backup_forbidden", 403);
    backups.authorize(actor);
    if (request.method === "GET") { reply(200, backups.overview(actor)); return; }
    if (request.method !== "POST") { reply(405, { code: "method_not_allowed", error: "method_not_allowed" }); return; }
    const parsed = backupCommandSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new BackupError("backup_invalid");
    const input = parsed.data;
    if (input.action === "create") reply(202, backups.create(actor, input.idempotencyKey));
    else if (input.action === "preview") reply(200, await restores.preview(actor, input.backupId));
    else if (input.action === "status") reply(200, input.backupId ? restores.status(actor, input.backupId, input.idempotencyKey) : backups.status(actor, input.idempotencyKey));
    else {
      const status = await restores.admit(actor, input);
      // A lost response still leaves a durable request. The close event starts
      // the same operation; duplicate listeners are coalesced by the service.
      let launched = false;
      const launch = () => { if (!launched) { launched = true; setImmediate(() => restores.launch(actor, input)); } };
      response.once("finish", launch); response.once("close", launch);
      // Async validation may finish after the client's close event already fired.
      if (response.destroyed || response.writableFinished) launch();
      reply(202, status);
    }
  } catch (error) {
    const failure = error instanceof BackupError ? error : new BackupError("backup_failed");
    reply(failure.status, { code: failure.code, error: failure.code });
  }
}
