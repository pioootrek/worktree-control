import Database from "better-sqlite3";
import { IdentityService } from "@/server/modules/identity";
import { acquireDatabaseOwnership } from "./owned-database";
import { IdentityQueries } from "./identity-queries";
import { RemoteConnectionQueries } from "./remote-connection-queries";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "./schema-inspection";

/** Inspection authenticates without updating last-used timestamps or running migrations. */
class InspectionIdentityQueries extends IdentityQueries {
  override recordCredentialUsed(): void {}
}
export function openRemoteRecoveryInspection(path: string) {
  const ownership = acquireDatabaseOwnership(path, { inspectOnly: true });
  let database: Database.Database | undefined;
  try {
    database = new Database(ownership.path, { readonly: true, fileMustExist: true });
    if (inspectSchema(database).version !== SUPPORTED_SCHEMA_VERSION) throw new Error("recovery_schema_upgrade_required");
    return {
      identity: new IdentityService(new InspectionIdentityQueries(database)),
      connection: new RemoteConnectionQueries(database),
      close() { try { database!.close(); } finally { ownership.lock.release(); } },
    };
  } catch (error) { try { database?.close(); } finally { ownership.lock.release(); } throw error; }
}
