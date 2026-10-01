import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { restoreControllerBackup } from "../../../controller-backup";
import { OwnedSqliteDatabase } from "../owned-database";

const [root, point, mode = "restore"] = process.argv.slice(2);
const database = join(root, "state.sqlite3"), attachments = join(root, "attachments");
const old = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`, `${database}.initializing`, attachments];
function hold() {
  process.send?.({ point });
  const deadline = Date.now() + 100;
  while (Date.now() < deadline) { /* Allow the IPC message to flush before SIGKILL. */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const source = String(from), target = String(to);
  const step = source.includes("/new/") ? (target === database ? 6 : target === attachments ? 7 : -1) : target.includes("/previous/") ? old.indexOf(source) : -1;
  if (point === `before-${step}`) hold();
  rename(from, to);
  if (point === `after-${step}`) hold();
  if (target.endsWith("/journal.json")) {
    const state = JSON.parse(fs.readFileSync(target, "utf8")).payload;
    if (point === "prepared" && state.state === "prepared" && state.intent === null) hold();
    if (point === "verified" && state.state === "verified") hold();
  }
  if (point === "published" && target === `${database}.restore`) hold();
};
syncBuiltinESMExports();
if (mode === "recovery") new OwnedSqliteDatabase(database).close();
else restoreControllerBackup(join(root, "backup"), database, attachments);
throw new Error("Restore fixture missed the requested boundary.");
