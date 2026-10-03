// Trusted fixture wrapper only: intercept installed CLI syscalls, then wait for parent SIGKILL.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const input = JSON.parse(process.argv[2]);
function hold() {
  process.send?.({ point: input.point });
  const deadline = Date.now() + 100;
  while (Date.now() < deadline) { /* Flush IPC before blocking. */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
let published = false;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const replace = String(from).endsWith("/new/state.sqlite3") && String(to) === input.database;
  if (replace && input.point === "restore-before") hold();
  rename(from, to);
  if (String(to).startsWith(`${input.backups}/pre-migration-v24-`)) published = true;
  if (replace && input.point === "restore-after") hold();
};
const fsync = fs.fsyncSync;
fs.fsyncSync = fd => {
  fsync(fd);
  if (published && input.point === "migration-after-copy" && fs.readlinkSync(`/proc/self/fd/${fd}`) === input.backups) hold();
};
syncBuiltinESMExports();
if (input.point === "migration-before") {
  const { default: Database } = await import(pathToFileURL(join(input.packageRoot, "node_modules/better-sqlite3/lib/index.js")));
  const execute = Database.prototype.exec;
  Database.prototype.exec = function(sql) {
    if (this.name === input.database && /CREATE|ALTER|DROP/i.test(sql)) hold();
    return execute.call(this, sql);
  };
}
const cli = join(input.packageRoot, "dist/cli/index.js");
process.argv = [process.execPath, cli, ...input.args];
await import(pathToFileURL(cli));
