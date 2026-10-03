// Explicit repository test driver; the application runs from the installed prefix.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Installed package root is required.");
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./package-remote-rebind.ts", import.meta.url)), packageRoot], { stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
