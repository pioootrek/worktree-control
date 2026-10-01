import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService } from "@/server/modules/authentication";
import { BackupOperations, backupPolicySchema, RestoreOperations } from "../index";
const [root, point] = process.argv.slice(2);
const database = join(root, "state.sqlite3"), attachments = join(root, "attachments");
const policy = backupPolicySchema.parse({ directory: join(root, "copies"), uiActions: ["create", "restore"] });
function hold() { process.send?.({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  const target = String(to);
  if (target.endsWith("/handoff.json")) {
    const record = JSON.parse(fs.readFileSync(target, "utf8")).payload;
    if (record.state === point) hold();
  }
  if (target.endsWith("/journal.json") && point === "restore-intent") {
    const record = JSON.parse(fs.readFileSync(target, "utf8")).payload;
    if (record.intent !== null) hold();
  }
  if (target.endsWith("/journal.json") && point === "restore-verified") {
    if (JSON.parse(fs.readFileSync(target, "utf8")).payload.state === "verified") hold();
  }
};
syncBuiltinESMExports();
const store = new SqliteStateStore(database), authentication = new AuthenticationService(store);
const actor = authentication.authenticateInstallation(fs.readFileSync(join(root, "current-token"), "utf8"))!;
let maintenance = false;
const backups = new BackupOperations(policy, { databasePath: database, attachmentDirectory: attachments, applicationVersion: "fixture", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: actor => authentication.isCurrentInstallationActor(actor), maintenance: () => maintenance });
const restores = new RestoreOperations(backups, database, attachments, { authentication: () => store.getAuthenticationPolicy(), enterMaintenance: () => { maintenance = true; }, restart: async execute => { await backups.close(); store.close(); if (point === "closed") hold(); execute(); if (point === "receipt") hold(); }, failure: error => { throw error; } });
const input = { action: "restore", backupId: fs.readFileSync(join(root, "backup-id"), "utf8"), idempotencyKey: "crash-restore", confirmation: "replace-entire-installation" };
restores.admit(actor, input); restores.launch(actor, input);
