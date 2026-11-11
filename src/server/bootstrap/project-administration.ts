import type { DashboardChangeKind, DashboardResponse, ProjectSnapshot, ProjectView, RuntimeSnapshot } from "@/shared/contracts";
import type { WebExportStatus } from "@/shared/contracts/godot-web";
import type { DatabaseAdmission } from "../database-admission";
import { parseAddProject } from "../http-server";

export interface ProjectAdministrationService {
  dashboard(): Promise<DashboardResponse>;
  addProject(input: ReturnType<typeof parseAddProject>): Promise<ProjectView>;
  removeProject(projectId: string): Promise<ProjectView>;
  configureGodotWeb(projectId: string, config: unknown): Promise<ProjectView>;
  rebuildWebExport(projectId: string): Promise<WebExportStatus>;
}

export interface ProjectAdministrationDependencies {
  service: ProjectAdministrationService;
  admission: DatabaseAdmission;
  publish(change: { kinds: DashboardChangeKind[]; projectIds?: string[] }): void;
  maintenance(): boolean;
}

export type ProjectAdminAction = "dashboard" | "add" | "remove" | "configure-godot-web" | "rebuild-web-export";

/**
 * Project registration over the owner-only admin socket. Operating-system permissions are the
 * credential, as for offline CLI access with the controller lock, so a running controller in an
 * account mode stays manageable from the CLI. Validation and change events match the HTTP routes.
 */
export function projectAdminHandler(dependencies: ProjectAdministrationDependencies) {
  const { service, admission, publish, maintenance } = dependencies;
  return (body: unknown): Promise<unknown> => admission.run(async () => {
    if (maintenance()) throw new Error("Controller is in maintenance.");
    const request = parseRequest(body);
    switch (request.action) {
      case "dashboard":
        return projectOverview(await service.dashboard());
      case "add": {
        const project = await service.addProject(parseAddProject(request.input));
        publish({ kinds: ["topology", "metadata"], projectIds: [project.id] });
        return { project: projectSummary(project) };
      }
      case "remove": {
        const project = await service.removeProject(request.projectId);
        publish({ kinds: ["topology"] });
        return { project: projectSummary(project) };
      }
      case "configure-godot-web": {
        const project = await service.configureGodotWeb(request.projectId, request.config);
        publish({ kinds: ["topology", "metadata"], projectIds: [request.projectId] });
        return { project: projectSummary(project) };
      }
      case "rebuild-web-export": {
        const webExport = await service.rebuildWebExport(request.projectId);
        publish({ kinds: ["runtime", "tests"], projectIds: [request.projectId] });
        return { webExport };
      }
    }
  });
}

/**
 * Project fields returned over the socket. Environment values, profiles and preset maps have no
 * aggregate bound, so they stay out of the reply; the CLI never reads them.
 */
export type ProjectSummary = Omit<ProjectView, "environment" | "environmentProfiles" | "testEnvironmentProfiles" | "testPresetProfiles" | "testPresetTimeouts">;

/** Runtime state without its retained log tail. */
export type RuntimeSummary = Omit<RuntimeSnapshot, "logs">;

export interface ProjectOverviewEntry extends Pick<ProjectSnapshot, "reservation" | "discoveryError"> {
  project: ProjectSummary;
  runtime: RuntimeSummary;
}

/** An explicit allowlist, so a new project field never reaches the socket reply by default. */
export function projectSummary(project: ProjectView): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    repositoryPath: project.repositoryPath,
    port: project.port,
    launchPreset: project.launchPreset,
    tlsMode: project.tlsMode,
    tlsKeyPath: project.tlsKeyPath,
    tlsCertPath: project.tlsCertPath,
    tlsCaPath: project.tlsCaPath,
    executable: project.executable,
    args: project.args,
    selectedEnvironmentProfile: project.selectedEnvironmentProfile,
    godotWeb: project.godotWeb,
    healthcheckPath: project.healthcheckPath,
    startupTimeoutMs: project.startupTimeoutMs,
    selectedWorktreePath: project.selectedWorktreePath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function runtimeSummary(runtime: RuntimeSnapshot): RuntimeSummary {
  return {
    phase: runtime.phase,
    pid: runtime.pid,
    worktreePath: runtime.worktreePath,
    startedAt: runtime.startedAt,
    error: runtime.error,
    failure: runtime.failure,
    resources: runtime.resources,
  };
}

/** The fields project commands read. Test history, runtime logs and environment data stay out of the reply. */
function projectOverview(dashboard: DashboardResponse): { projects: ProjectOverviewEntry[] } {
  return {
    projects: dashboard.projects.map(({ project, runtime, reservation, discoveryError }) => ({
      project: projectSummary(project),
      runtime: runtimeSummary(runtime),
      reservation,
      ...(discoveryError ? { discoveryError } : {}),
    })),
  };
}

type ProjectAdminRequest =
  | { action: "dashboard" }
  | { action: "add"; input: unknown }
  | { action: "remove" | "rebuild-web-export"; projectId: string }
  | { action: "configure-godot-web"; projectId: string; config: unknown };

function parseRequest(body: unknown): ProjectAdminRequest {
  const invalid = () => new Error("Invalid project administration request.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record.command !== "project") throw invalid();
  switch (record.action) {
    case "dashboard":
      if (keys !== "action,command") throw invalid();
      return { action: "dashboard" };
    case "add":
      if (keys !== "action,command,input") throw invalid();
      return { action: "add", input: record.input };
    case "remove":
    case "rebuild-web-export":
      if (keys !== "action,command,projectId") throw invalid();
      return { action: record.action, projectId: projectId(record.projectId, invalid) };
    case "configure-godot-web":
      if (keys !== "action,command,config,projectId") throw invalid();
      return { action: "configure-godot-web", projectId: projectId(record.projectId, invalid), config: record.config };
    default:
      throw invalid();
  }
}

function projectId(value: unknown, invalid: () => Error): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw invalid();
  return value;
}
