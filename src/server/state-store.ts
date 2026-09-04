import type { DevServerTlsMode, EnvironmentProfile, Project, Reservation, ServerCapacitySettings, WorktreeStorageHistoryPoint, WorktreeStorageSnapshot } from "@/shared/contracts";

export interface WorktreeStorageSample extends WorktreeStorageHistoryPoint {
  projectId: string;
  worktreePath: string;
  topDirectories: Array<{ name: string; bytes: number }>;
}

export interface NewProject {
  name: string;
  repositoryPath: string;
  port: number;
}

export interface ProjectRegistration extends NewProject {
  executable: string;
  args: string[];
}

export interface ProjectLaunchUpdate {
  tlsMode: DevServerTlsMode;
  tlsKeyPath: string | null;
  tlsCertPath: string | null;
  tlsCaPath: string | null;
  executable: string;
  args: string[];
}

export interface ReservationRequest {
  projectId: string;
  worktreePath: string;
  kind: "human" | "agent";
  owner: string;
  reason?: string;
  ttlSeconds?: number;
  maximumLifetimeSeconds?: number;
  leaseTokenHash?: string;
  idempotencyKey?: string;
}

export interface StateStore {
  listProjects(): Project[];
  getProject(id: string): Project | null;
  addProject(input: ProjectRegistration): Project;
  updateProjectLaunch(projectId: string, input: ProjectLaunchUpdate): void;
  updateProjectEnvironment(projectId: string, environment: Record<string, string>, actor: string): void;
  saveProjectEnvironmentProfile(projectId: string, profile: EnvironmentProfile, actor: string): void;
  deleteProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  selectProjectEnvironmentProfile(projectId: string, profileName: string, actor: string): void;
  setSelectedWorktree(projectId: string, path: string): void;
  getServerCapacitySettings(): ServerCapacitySettings;
  setServerCapacitySettings(settings: ServerCapacitySettings): void;
  getWorktreeStorage(projectId: string, worktreePath: string): WorktreeStorageSnapshot | null;
  saveWorktreeStorage(sample: WorktreeStorageSample): void;
  recordProjectEvent(projectId: string, eventType: string, actor: string, details: unknown): void;
  getActiveReservation(projectId: string): Reservation | null;
  acquireReservation(input: ReservationRequest): Reservation;
  authorizeReservation(projectId: string, owner: string, leaseTokenHash?: string): Reservation | null;
  renewAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string, ttlSeconds: number): Reservation;
  releaseAgentReservation(projectId: string, reservationId: string, owner: string, leaseTokenHash: string): void;
  releaseReservation(projectId: string, owner: string, force?: boolean): void;
  close(): void;
}
