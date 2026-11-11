import { describe, expect, it, vi } from "vitest";
import { directAdmission, type DatabaseAdmission } from "../database-admission";
import { projectAdminHandler, type ProjectAdministrationService } from "./project-administration";

function fixture(maintenance = false) {
  const project = { id: "project-1", name: "Fixture" };
  const service = {
    dashboard: vi.fn(async () => ({ projects: [] })),
    addProject: vi.fn(async () => project),
    removeProject: vi.fn(async () => project),
    configureGodotWeb: vi.fn(async () => project),
    rebuildWebExport: vi.fn(async () => ({ phase: "queued" })),
  } as unknown as ProjectAdministrationService & Record<string, ReturnType<typeof vi.fn>>;
  const publish = vi.fn();
  const admitted = { count: 0 };
  const admission: DatabaseAdmission = {
    ...directAdmission,
    run: (operation) => { admitted.count += 1; return directAdmission.run(operation); },
  };
  const execute = projectAdminHandler({ service, admission, publish, maintenance: () => maintenance });
  return { service, publish, admitted, execute };
}

describe("project administration over the admin socket", () => {
  it("validates registration like HTTP and publishes the same change", async () => {
    const { service, publish, admitted, execute } = fixture();
    const input = { name: "Fixture", repositoryPath: "/srv/fixture", port: 3100, launchPreset: "node" };
    expect(await execute({ command: "project", action: "add", input })).toEqual({ project: { id: "project-1", name: "Fixture" } });
    expect(service.addProject).toHaveBeenCalledWith(input);
    expect(publish).toHaveBeenCalledWith({ kinds: ["topology", "metadata"], projectIds: ["project-1"] });
    expect(admitted.count).toBe(1);
    await expect(execute({ command: "project", action: "add", input: { ...input, port: 80 } })).rejects.toThrow("port");
    await expect(execute({ command: "project", action: "add", input: { ...input, owner: "x" } })).rejects.toThrow();
    expect(service.addProject).toHaveBeenCalledTimes(1);
  });

  it("removes a project and publishes a topology change", async () => {
    const { service, publish, execute } = fixture();
    await execute({ command: "project", action: "remove", projectId: "project-1" });
    expect(service.removeProject).toHaveBeenCalledWith("project-1");
    expect(publish).toHaveBeenCalledWith({ kinds: ["topology"] });
  });

  it("returns only the fields project commands read, without history, logs or environment data", async () => {
    const { service, execute } = fixture();
    const large = "x".repeat(4_000);
    const project = {
      id: "project-1", name: "Fixture", godotWeb: { watch: { paths: Array.from({ length: 16 }, () => "w".repeat(240)) } },
      environment: { TOKEN: large }, environmentProfiles: Array.from({ length: 150 }, (_, index) => ({ name: `p${index}`, environment: { VALUE: large } })),
      testEnvironmentProfiles: [{ name: "ci", variableNames: ["A"] }], testPresetProfiles: { "node:test": "ci" }, testPresetTimeouts: { "node:test": 1000 },
    };
    const runtime = { phase: "running", error: null, logs: Array.from({ length: 400 }, () => large) };
    const logs = Array.from({ length: 200 }, () => "x".repeat(2_000));
    (service.dashboard as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      projects: [{ project, runtime, reservation: null, worktrees: [], testRuns: Array.from({ length: 50 }, (_, index) => ({ id: `run-${index}`, logs })), discoveryError: "Discovery failed." }],
    });
    const overview = await execute({ command: "project", action: "dashboard" });
    expect(overview).toEqual({ projects: [{ project: { id: "project-1", name: "Fixture" }, runtime: { phase: "running", error: null }, reservation: null, discoveryError: "Discovery failed." }] });
    expect(JSON.stringify(overview).length).toBeLessThan(1_000);
    (service.removeProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce(project);
    // A single-project receipt keeps the bounded Godot Web configuration; the overview does not.
    expect(await execute({ command: "project", action: "remove", projectId: "project-1" })).toEqual({ project: { id: "project-1", name: "Fixture", godotWeb: project.godotWeb } });
  });

  it("rejects unknown shapes and refuses during maintenance", async () => {
    const { execute } = fixture();
    await expect(execute({ command: "project", action: "dashboard", extra: true })).rejects.toThrow("Invalid project administration request.");
    await expect(execute({ command: "project", action: "start", projectId: "project-1" })).rejects.toThrow("Invalid project administration request.");
    await expect(execute({ command: "project", action: "remove", projectId: "" })).rejects.toThrow("Invalid project administration request.");
    const closed = fixture(true);
    await expect(closed.execute({ command: "project", action: "dashboard" })).rejects.toThrow("maintenance");
    expect(closed.service.dashboard).not.toHaveBeenCalled();
  });
});
