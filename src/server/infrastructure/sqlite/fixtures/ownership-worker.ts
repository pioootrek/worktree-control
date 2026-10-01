// Isolated process fixture. No controller listener or managed project is started.
import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { OwnedSqliteDatabase } from "../index";
let state: ControllerLock | undefined;
let database: OwnedSqliteDatabase | undefined;
process.on("message", message => {
  if (message === "acquire") {
    try {
      state = acquireControllerLock(process.argv[3]!);
      database = new OwnedSqliteDatabase(process.argv[2]!);
      process.send?.({ acquired:true });
    } catch (error) {
      state?.release();
      process.send?.({ acquired:false, error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
    }
  } else if (message === "release") {
    database?.close(); state?.release(); process.exit(0);
  }
});
process.send?.({ ready:true });
