import { z } from "zod";
import { verifyBackupSnapshot } from "../server/infrastructure/sqlite";

// This child has no controller store, singleton ownership or transport listener.
// Its only SQLite connection belongs to a disposable verification clone.
process.once("message", value => {
  try {
    const input = z.object({ source: z.string(), scratch: z.string(), temporary: z.string(), maxBytes: z.number().int().positive() }).strict().parse(value);
    const manifest = verifyBackupSnapshot(input.source, input.scratch, input.temporary, input.maxBytes);
    process.send?.({ manifest }, () => process.disconnect());
  } catch { process.exitCode = 1; process.disconnect(); }
});
process.once("disconnect", () => { /* The child exits when no verification is active. */ });
