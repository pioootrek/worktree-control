import type { DashboardChangeKind, DashboardResponse, ProjectView } from "@/shared/contracts";
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
        return service.dashboard();
      case "add": {
        const project = await service.addProject(parseAddProject(request.input));
        publish({ kinds: ["topology", "metadata"], projectIds: [project.id] });
        return { project };
      }
      case "remove": {
        const project = await service.removeProject(request.projectId);
        publish({ kinds: ["topology"] });
        return { project };
      }
      case "configure-godot-web": {
        const project = await service.configureGodotWeb(request.projectId, request.config);
        publish({ kinds: ["topology", "metadata"], projectIds: [request.projectId] });
        return { project };
      }
      case "rebuild-web-export": {
        const webExport = await service.rebuildWebExport(request.projectId);
        publish({ kinds: ["runtime", "tests"], projectIds: [request.projectId] });
        return { webExport };
      }
    }
  });
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
