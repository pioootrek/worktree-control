import { join } from "node:path";
import { remoteRebindAcceptance } from "../tests/support/remote-rebind-acceptance";
const packageRoot = process.argv[2];
try {
  console.log(JSON.stringify(await remoteRebindAcceptance({ cli: join(packageRoot, "dist/cli/index.js"), webRoot: join(packageRoot, "out") })));
} catch { console.error("Installed remote rebind fixture failed; no operational recovery claim."); process.exitCode = 1; }
