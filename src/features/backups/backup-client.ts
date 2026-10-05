import type { BackupCommand, BackupOverview, BackupOperation, RestoreOperation, RestorePreview } from "@/shared/contracts/backups";
export class BackupClientError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export async function backupRequest<T = BackupOverview | BackupOperation | RestoreOperation | RestorePreview>(token: string, input?: BackupCommand): Promise<T> {
  const response = await fetch("/api/backups", { method: input ? "POST" : "GET", cache: "no-store", headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": token }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new BackupClientError(typeof body.code === "string" ? body.code : "backup_failed", response.status);
  return body as T;
}
