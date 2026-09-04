import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "@/shared/contracts";
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
    tlsMode: "off",
    tlsKeyPath: null,
    tlsCertPath: null,
    tlsCaPath: null,
    executable: process.execPath,
    args: ["-e", "require('node:http').createServer((_,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"],
    environment: {},
    environmentProfiles: [{ name: "default", environment: {} }],
    selectedEnvironmentProfile: "default",
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
});

describe("ProcessManager", () => {
  it("starts a healthy server and stops its owned process group", async () => {
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    await manager.start(fixture, process.cwd());
    expect(manager.snapshot(fixture.id).phase).toBe("running");
    await manager.stop(fixture.id);
    expect(manager.snapshot(fixture.id).phase).toBe("stopped");
  });

  it("injects project environment overrides into the child process", async () => {
    const manager = new ProcessManager();
    managers.push(manager);
    const fixture = project(await unusedPort());
    fixture.environment = { SWITCHER_TEST_VALUE: "injected" };
    fixture.args = ["-e", "require('node:http').createServer((_,r)=>r.end(process.env.SWITCHER_TEST_VALUE)).listen(Number(process.env.PORT),'127.0.0.1')"];
    await manager.start(fixture, process.cwd());
    expect(await (await fetch(`http://127.0.0.1:${fixture.port}`)).text()).toBe("injected");
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
