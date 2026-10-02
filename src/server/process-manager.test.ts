import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/shared/contracts";
import { OwnedProcessGroup } from "./owned-process-group";
import { ProcessManager } from "./process-manager";
import type { ProcessResourceSampler, RawResourceSample } from "./resource-monitor";

const managers: ProcessManager[] = [];

function project(port: number): Project {
  const now = new Date().toISOString();
  return {
    id: "fixture",
    name: "Fixture",
    repositoryPath: process.cwd(),
    port,
    launchPreset: "node",
    tlsMode: "off",
    tlsKeyPath: null,
    tlsCertPath: null,
    tlsCaPath: null,
    executable: process.execPath,
    args: ["-e", "require('node:http').createServer((_,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"],
    environment: {},
    environmentProfiles: [{ name: "default", environment: {} }],
    selectedEnvironmentProfile: "default",
    testEnvironmentProfiles: [],
    testPresetProfiles: {},
    healthcheckPath: "/",
    startupTimeoutMs: 5000,
    selectedWorktreePath: process.cwd(),
    createdAt: now,
    updatedAt: now,
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  vi.unstubAllEnvs();
});

describe("ProcessManager", () => {
  it("cancels a pending start on shutdown and refuses queued starts before spawn", async () => {
    const manager = new ProcessManager(); managers.push(manager);
    const fixture = project(await unusedPort());
    fixture.args = ["-e", "setInterval(() => {}, 1000)"];
    fixture.startupTimeoutMs = 60_000;
    const starting = manager.start(fixture, process.cwd());
    const rejected = expect(starting).rejects.toThrow(/podczas startu|zamykany/);
    await waitFor(() => manager.snapshot(fixture.id).phase === "starting");
    const pid = manager.snapshot(fixture.id).pid!;
    manager.closeAdmission();
    await manager.stopAll(); await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    const beforeSpawn = vi.fn();
    await expect(manager.start({ ...fixture, id: "queued" }, process.cwd(), beforeSpawn)).rejects.toThrow("zamykany");
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(manager.statusSummary(fixture.id).ownsProcess).toBe(false);
  });
  it("starts a healthy server and stops its owned process group", async () => {
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    await manager.start(fixture, process.cwd());
    expect(manager.snapshot(fixture.id).phase).toBe("running");
    await manager.stop(fixture.id);
    expect(manager.snapshot(fixture.id).phase).toBe("stopped");
  });

  it("retains ownership after cleanup failure and permits a safe retry", async () => {
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    await manager.start(fixture, process.cwd());
    const pid = manager.snapshot(fixture.id).pid;
    const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockRejectedValueOnce(new Error("inspection unavailable"));
    await expect(manager.stop(fixture.id)).rejects.toThrow("inspection unavailable");
    expect(manager.snapshot(fixture.id)).toMatchObject({ phase: "failed", pid });
    expect(manager.statusSummary(fixture.id)).toMatchObject({ phase: "failed", ownsProcess: true });
    await expect(manager.start(fixture, process.cwd())).rejects.toThrow("już działa");
    stop.mockRestore();
    await manager.stop(fixture.id);
    expect(manager.snapshot(fixture.id)).toMatchObject({ phase: "stopped", pid: null });
    expect(manager.statusSummary(fixture.id).ownsProcess).toBe(false);
  });

  it.each(["stop", "shutdown", "early-exit", "startup-timeout"])(
    "cleans stubborn descendants before releasing ownership: %s",
    async (mode) => {
      const manager = new ProcessManager();
      managers.push(manager);
      const fixture = project(await unusedPort());
      const descendant = `
        process.on('SIGTERM', () => {});
        require('node:http').createServer((_, r) => r.end('descendant'))
          .listen(Number(process.env.PORT), '127.0.0.1', () => process.send('ready'));
      `;
      fixture.args = ["-e", `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.on('message', () => {
          console.log('descendant-ready');
          ${mode === "early-exit" ? "process.exit(7);" : ""}
        });
        process.on('SIGTERM', () => process.exit(0));
      `];
      if (mode === "startup-timeout") {
        // Keep HTTP open but make both health probes report not-ready.
        vi.spyOn(manager as unknown as { isHealthy: () => Promise<boolean> }, "isHealthy").mockResolvedValue(false);
        fixture.startupTimeoutMs = 700;
      }
      if (mode === "early-exit" || mode === "startup-timeout") {
        await expect(manager.start(fixture, process.cwd())).rejects.toThrow();
        expect(manager.snapshot(fixture.id).phase).toBe("failed");
      } else {
        await manager.start(fixture, process.cwd());
        const stopping = mode === "shutdown" ? manager.stopAll() : manager.stop(fixture.id);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(manager.snapshot(fixture.id)).toMatchObject({ phase: "stopping", pid: expect.any(Number) });
        expect(await (await fetch(`http://127.0.0.1:${fixture.port}`)).text()).toBe("descendant");
        await stopping;
        expect(manager.snapshot(fixture.id).phase).toBe("stopped");
      }
      expect(manager.snapshot(fixture.id).pid).toBeNull();
      await expect(fetch(`http://127.0.0.1:${fixture.port}`)).rejects.toThrow();
      await Promise.all([manager.stop(fixture.id), manager.stop(fixture.id)]);
      // The same port can be reused by the next worktree/runtime.
      vi.restoreAllMocks();
      await manager.start(project(fixture.port), process.cwd());
      expect(manager.snapshot(fixture.id).phase).toBe("running");
    }, 12_000,
  );

  it("injects project environment overrides into the child process", async () => {
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    fixture.environment = { SWITCHER_TEST_VALUE: "injected" };
    fixture.args = ["-e", "require('node:http').createServer((_,r)=>r.end(process.env.SWITCHER_TEST_VALUE)).listen(Number(process.env.PORT),'127.0.0.1')"];
    await manager.start(fixture, process.cwd());
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}`)).text()).toBe("injected");
  });

  it("uses development NODE_ENV when the controller runs in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    fixture.environment = { NODE_ENV: "production" };
    fixture.args = ["-e", "require('node:http').createServer((_,r)=>r.end(process.env.NODE_ENV)).listen(Number(process.env.PORT),'127.0.0.1')"];

    await manager.start(fixture, process.cwd());

    expect(await (await fetch(`http://127.0.0.1:${fixture.port}`)).text()).toBe("development");
  });

  it("does not kill an unrelated process occupying the port", async () => {
    const server = createServer((_, response) => response.end("foreign"));
    const lanAddress = Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .find((address) => address.family === "IPv4" && !address.internal)?.address ?? "127.0.0.1";
    await new Promise<void>((resolve) => server.listen(0, lanAddress, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const manager = new ProcessManager();
    managers.push(manager);

    await expect(manager.start(project(address.port), process.cwd())).rejects.toThrow("inny serwer");
    expect(server.listening).toBe(true);
    expect(manager.snapshot("fixture").failure?.title).toBe(`Port ${address.port} jest już używany`);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("tracks current, peak, CPU, and bounded history while the process is active", async () => {
    let calls = 0;
    const sampler: ProcessResourceSampler = {
      supported: true,
      sample: async (): Promise<RawResourceSample> => {
        calls += 1;
        return {
          rssBytes: calls === 1 ? 10_000 : 8_000,
          processCount: 3,
          processCpuTicks: calls * 20,
          hostCpuTicks: calls * 200,
          cpuCount: 4,
        };
      },
    };
    const manager = new ProcessManager(undefined, undefined, {
      resourceSampler: sampler,
      resourceSampleIntervalMs: 20,
      maxResourceHistoryPoints: 2,
      memoryWarningThresholdBytes: 9_000,
    });
    managers.push(manager);
    const fixture = project(await unusedPort());

    await manager.start(fixture, process.cwd());
    await waitFor(() => calls >= 3);
    const resources = manager.snapshot(fixture.id).resources;
    expect(resources).toMatchObject({
      status: "available",
      currentRssBytes: 8_000,
      peakRssBytes: 10_000,
      cpuPercent: 40,
      processCount: 3,
      warningThresholdBytes: 9_000,
    });
    expect(resources.history).toHaveLength(2);

    await manager.stop(fixture.id);
    const stopped = manager.snapshot(fixture.id).resources;
    expect(stopped.status).toBe("stale");
    expect(stopped.currentRssBytes).toBeNull();
    const callsAfterStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(callsAfterStop);
  });

  it("degrades to unsupported without affecting server startup", async () => {
    const sampler: ProcessResourceSampler = {
      supported: false,
      sample: async () => { throw new Error("unsupported"); },
    };
    const manager = new ProcessManager(undefined, undefined, { resourceSampler: sampler, resourceSampleIntervalMs: 20 });
    managers.push(manager);
    const fixture = project(await unusedPort());
    await manager.start(fixture, process.cwd());
    await waitFor(() => manager.snapshot(fixture.id).resources.status === "unsupported");
    expect(manager.snapshot(fixture.id).phase).toBe("running");
  });
});
