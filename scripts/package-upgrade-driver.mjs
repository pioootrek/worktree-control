// Explicit repository driver; old/new application behavior comes from installed artifacts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./package-upgrade-acceptance.mjs", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
