import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { OwnedProcessGroup } from "@/server/owned-process-group";
import { PreparationSession } from "./preparation-session";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "wtc-preparation-process-")); roots.push(path); return path; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("discards setup output without turning noisy installation into a buffer failure", async () => {
  const session = new PreparationSession(5_000);
  try {
    await expect(session.command({ executable: process.execPath, args: ["-e", "console.log('x'.repeat(100000));"], cwd: directory(), environment: {}, maxOutputBytes: 0, errorCode: "install_failed" })).resolves.toBe("");
  } finally { session.close(); }
});

it("applies one preparation deadline across commands and confirms descendant cleanup", async () => {
  const root = directory(), marker = join(root, "child-pid");
  const session = new PreparationSession(1_000);
  try {
    await session.command({ executable: process.execPath, args: ["-e", "setTimeout(()=>{},500)"], cwd: root, environment: {}, errorCode: "first_failed" });
    const command = session.command({ executable: process.execPath, args: ["-e", `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));
      setTimeout(()=>process.exit(0),100);
    `], cwd: root, environment: {}, errorCode: "second_failed" });
    await expect(command).rejects.toMatchObject({ code: "preparation_timeout" });
    // Match OwnedProcessGroup's treatment of non-running zombies.
    expect(session.cleanupUnconfirmed).toBe(false);
    const pid = readFileSync(marker, "utf8");
    let state = "";
    try { state = execFileSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).trim(); }
    catch (error) { expect((error as { status: number }).status).toBe(1); }
    expect(!state || state.startsWith("Z")).toBe(true);
  } finally { session.close(); }
}, 15_000);

it("keeps cleanup uncertain when owned-tree stop cannot be confirmed", async () => {
  const root = directory(), marker = join(root, "pid");
  const session = new PreparationSession(5_000);
  const original = OwnedProcessGroup.prototype.stop;
  let owned: OwnedProcessGroup | undefined;
  vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementationOnce(function (this: OwnedProcessGroup) {
    owned = this; return Promise.reject(new Error("fixture inspection unavailable"));
  });
  try {
    const command = session.command({ executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`], cwd: root, environment: {}, errorCode: "install_failed" });
    await vi.waitFor(() => expect(() => readFileSync(marker)).not.toThrow());
    session.cancel();
    await expect(command).rejects.toMatchObject({ code: "preparation_cleanup_unconfirmed", cleanupUnconfirmed: true });
    expect(session.cleanupUnconfirmed).toBe(true);
    expect(alive(Number(readFileSync(marker, "utf8")))).toBe(true);
  } finally {
    session.close(); vi.restoreAllMocks();
    if (owned) await original.call(owned);
  }
});
