import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Finite child-only preload: no production configuration or environment fault switch.
// Arm AFTER startup, provider initialization and backup completion. Read-only observers
// and backup connections still close normally. The actual writable owner's close fails.
const data = process.argv[process.argv.indexOf("--data-dir") + 1];
if (!data || !process.argv.includes("--service-mode")) throw new Error("Controller fixture arguments required.");
const databasePath = resolve(data, "state.sqlite3");
const close = Database.prototype.close;
Database.prototype.close = function () {
  if (!this.readonly && resolve(this.name) === databasePath && existsSync(join(data, "fixture-driver-close-failure"))) {
    process.stderr.write("fixture.driver_close_refused\n");
    throw new Error("fixture-driver-close-private-sentinel");
  }
  return close.call(this);
};
