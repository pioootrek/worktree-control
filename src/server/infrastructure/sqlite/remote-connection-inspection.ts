import { SecurityFence } from "./security-fence";
import { ExclusiveSqliteConnection } from "./exclusive-connection";
import { IdentityService } from "@/server/modules/identity";
import { OwnedSqliteDatabase } from "./owned-database";
import { IdentityQueries } from "./identity-queries";
import { RemoteConnectionQueries } from "./remote-connection-queries";

/** Inspection authenticates without updating last-used timestamps or running migrations. */
class InspectionIdentityQueries extends IdentityQueries {
  override recordCredentialUsed(): void {}
}
/**
 * The read-only remote recovery inspection: an ordinary opening, so the
 * admission check runs (fence first, then the version and the upgrade marker)
 * before anything reads a row; inspection-only ownership refuses an
 * unfinished restore instead of recovering it. Nothing is written.
 */
export function openRemoteRecoveryInspection(path: string) {
  const owner = new OwnedSqliteDatabase(path, false, undefined, { inspectOnly: true, ordinary: true });
  try {
    const core=new ExclusiveSqliteConnection(owner.database,{},SecurityFence.attach(owner.canonicalPath,owner.database,false)).core;
    return {
      identity: new IdentityService(new InspectionIdentityQueries(core)),
      connection: new RemoteConnectionQueries(core),
      close() { owner.close(); },
    };
  } catch (error) { owner.close(); throw error; }
}
