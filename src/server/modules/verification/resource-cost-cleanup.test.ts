import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OwnedProcessGroup, processGroupSelectionArgs } from "@/server/owned-process-group";
import { ProbeGroups } from "../../../../scripts/resource-sampling-lifecycle";

const execute = promisify(execFile);
async function liveGroup(pid: number) {
  try {
    const { stdout } = await execute("ps", processGroupSelectionArgs(pid), { timeout: 1000, maxBuffer: 64 * 1024 });
    return stdout.trim().split("\n").some(line => line.trim() && !line.trim().startsWith("Z"));
  } catch (error) {
    const e = error as { code: number; stdout: string };
    if (e.code === 1 && !e.stdout?.trim()) return false;
    throw error;
  }
}

describe.skipIf(process.platform !== "linux")("cost probe interruption with real detached fixtures", () => {
  it.each((["SIGTERM", "SIGINT"] as const).flatMap(signal =>
    (["spawn", "setup", "measurement", "cleanup", "job_group"] as const).map(phase => ({ signal, phase }))))(
    "awaits every fixture group after $signal during $phase", async ({ signal, phase }) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../../../scripts/test-resource-sampling-cost.ts", import.meta.url))], {
        detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const owned = new OwnedProcessGroup(child), fixtures = new Set<number>();
      let interrupted = false, cleaned = false, output = "", errors = "";
      child.stdout!.on("data", chunk => { output += chunk.toString(); });
      child.stderr!.on("data", chunk => { errors += chunk.toString(); });
      child.on("message", (message: { phase: string; pids: number[] }) => {
        for (const pid of message.pids) fixtures.add(pid);
        if (message.phase === "cleaned") cleaned = true;
        if (!interrupted && message.phase === (phase === "job_group" ? "measurement" : phase)) {
          interrupted = true;
          if (phase === "job_group") process.kill(-child.pid!, signal); else child.kill(signal);
        }
      });
      const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const deadline = setTimeout(() => child.kill("SIGTERM"), 12_000);
      try {
        const code = await exit;
        expect(interrupted).toBe(true);
        expect(code).not.toBe(0);
        expect(fixtures.size).toBeGreaterThanOrEqual(1);
        if (phase !== "spawn") expect(fixtures.size).toBe(3);
        expect(cleaned).toBe(true);
        expect(output).not.toContain('"cleanup":"confirmed"');
        expect(errors).toMatch(/interrupted|abort/i);
        for (const pid of fixtures) expect(await liveGroup(pid), `live fixture group ${pid}`).toBe(false);
        expect(await owned.alive()).toBe(false);
      } finally {
        clearTimeout(deadline);
        await owned.stop();
        // On a failed assertion, pipe closure and finite lifetimes remain the
        // backstop. Never signal a grandchild using a possibly retired PID.
      }
    }, 20_000,
  );

  it("closes fixture pipes after abrupt worker death without claiming synchronous SIGKILL cleanup", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../../../scripts/test-resource-sampling-cost.ts", import.meta.url)), "--worker", "baseline"], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const owned = new OwnedProcessGroup(child), fixtures = new Set<number>();
    child.on("message", (message: { phase: string; pids: number[] }) => {
      for (const pid of message.pids) fixtures.add(pid);
      if (message.phase === "measurement") child.kill("SIGKILL");
    });
    const exit = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", (_code, signal) => resolve(signal));
    });
    try {
      expect(await exit).toBe("SIGKILL");
      expect(fixtures.size).toBe(3);
      const until = Date.now() + 3000;
      while ((await Promise.all([...fixtures].map(liveGroup))).some(Boolean) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (const pid of fixtures) expect(await liveGroup(pid)).toBe(false);
    } finally { await owned.stop(); }
  }, 10_000);

  it("tries every group and shares one bounded cleanup result even after failure", async () => {
    const stops = [vi.fn(async () => {}), vi.fn(async () => { throw Error("inspection denied"); }), vi.fn(async () => {})];
    let next = 0;
    const groups = new ProbeGroups(() => ({ stop: stops[next++] }));
    for (let i = 0; i < 3; i++) groups.add({} as ChildProcess);
    const first = groups.stop();
    expect(groups.stop()).toBe(first);
    await expect(first).rejects.toThrow("Fixture cleanup was not confirmed");
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    await expect(groups.stop()).rejects.toThrow("Fixture cleanup was not confirmed");
  });
});
