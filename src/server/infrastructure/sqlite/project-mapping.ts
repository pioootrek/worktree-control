import type { LaunchPreset, Project } from "@/shared/contracts";

export type ProjectRow = {
  id: string;
  name: string;
  repository_path: string;
  port: number;
  launch_preset: LaunchPreset;
  tls_mode: "off" | "generated" | "custom";
  tls_key_path: string | null;
  tls_cert_path: string | null;
  tls_ca_path: string | null;
  executable: string;
  args_json: string;
  environment_json: string;
  environment_profiles_json: string;
  selected_environment_profile: string;
  test_environment_profiles_json: string;
  test_preset_profiles_json: string;
  test_preset_timeouts_json: string;
  healthcheck_path: string;
  startup_timeout_ms: number;
  selected_worktree_path: string | null;
  created_at: string;
  updated_at: string;
};

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repository_path,
    port: row.port,
    launchPreset: row.launch_preset,
    tlsMode: row.tls_mode,
    tlsKeyPath: row.tls_key_path,
    tlsCertPath: row.tls_cert_path,
    tlsCaPath: row.tls_ca_path,
    executable: row.executable,
    args: JSON.parse(row.args_json) as string[],
    environment: JSON.parse(row.environment_json) as Record<string, string>,
    environmentProfiles: JSON.parse(row.environment_profiles_json) as Project["environmentProfiles"],
    selectedEnvironmentProfile: row.selected_environment_profile,
    testEnvironmentProfiles: JSON.parse(row.test_environment_profiles_json) as Project["testEnvironmentProfiles"],
    testPresetProfiles: JSON.parse(row.test_preset_profiles_json) as Project["testPresetProfiles"],
    testPresetTimeouts: JSON.parse(row.test_preset_timeouts_json) as Project["testPresetTimeouts"],
    healthcheckPath: row.healthcheck_path,
    startupTimeoutMs: row.startup_timeout_ms,
    selectedWorktreePath: row.selected_worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
