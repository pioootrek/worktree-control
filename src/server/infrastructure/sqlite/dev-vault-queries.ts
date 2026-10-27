import type Database from "better-sqlite3";
import type { DevVaultSnapshot, DevVaultStore } from "@/server/modules/dev-vault";

/** Uses the controller's existing owned connection; never opens another database. */
export class DevVaultQueries implements DevVaultStore {
  constructor(private readonly database: Database.Database) {}
  projectExists(projectId: string): boolean { return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)); }
  load(projectId: string): DevVaultSnapshot | null {
    return this.database.prepare("SELECT version,ciphertext FROM dev_environment_vaults WHERE project_id=?").get(projectId) as DevVaultSnapshot | undefined ?? null;
  }
  commit(projectId: string, expectedVersion: number, ciphertext: string): boolean {
    return this.database.transaction(() => {
      if (!this.projectExists(projectId)) return false;
      if (expectedVersion === 0) return this.database.prepare("INSERT OR IGNORE INTO dev_environment_vaults(project_id,version,ciphertext) VALUES(?,1,?)")
        .run(projectId, ciphertext).changes === 1;
      return this.database.prepare("UPDATE dev_environment_vaults SET version=version+1,ciphertext=? WHERE project_id=? AND version=?")
        .run(ciphertext, projectId, expectedVersion).changes === 1;
    }).immediate();
  }
}
