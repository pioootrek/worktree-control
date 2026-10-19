// Private fixture: no ports/files and at most 20 seconds of life, including
// its leaf. Closing the worker's stdin pipe also requests awaited cleanup.
import { spawn } from "node:child_process";
const leaf = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000)"], { stdio: "ignore" });
const idle = setInterval(() => {}, 1000);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  leaf.kill("SIGTERM");
  const deadline = setTimeout(() => { leaf.kill("SIGKILL"); process.exit(1); }, 1000);
  leaf.once("close", () => { clearTimeout(deadline); clearInterval(idle); process.stdin.destroy(); });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.resume();
process.stdin.on("end", stop);
const lifetime = setTimeout(stop, 20000);
lifetime.unref();
leaf.on("error", () => { process.exitCode = 1; stop(); });
leaf.on("exit", () => { if (!stopping) { process.exitCode = 1; stop(); } });
