import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { rebindRemoteBackup } from "../index";
const [root, point] = process.argv.slice(2);
function hold() { process.send?.({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const relevant = String(to).endsWith("/remote.json");
  if (relevant && point === "before") hold();
  rename(from, to);
  if (relevant && point === "after") hold();
};
syncBuiltinESMExports();
await rebindRemoteBackup(JSON.parse(fs.readFileSync(join(root, "input.json"), "utf8")), async () => {});
