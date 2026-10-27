import { DevVaultOperations, DevVaultService, Ed25519DevVaultOwnerVerifier, type DevVaultLifecycle, type DevVaultStore } from "@/server/modules/dev-vault";
import { ExternalFileDevVaultKeyProvider, readExternalVaultFile } from "@/server/infrastructure/dev-vault";
import type { IdentityService } from "@/server/modules/identity";
import type { AppPaths } from "@/server/paths";
import { controllerRestoreBoundary } from "@/server/restore-requests";

export function createDevVault(store: DevVaultStore, identity: IdentityService, paths: AppPaths, lifecycle: DevVaultLifecycle, environment: Readonly<Record<string, string | undefined>> = process.env): DevVaultOperations {
  const excluded = [paths.dataDirectory, paths.stateDirectory];
  const keyPath = environment.WORKTREE_CONTROL_DEV_VAULT_KEY_FILE;
  const ownerKeyPath = environment.WORKTREE_CONTROL_DEV_VAULT_OWNER_PUBLIC_KEY_FILE;
  const service = new DevVaultService(store, new ExternalFileDevVaultKeyProvider(keyPath, excluded), identity,
    new Ed25519DevVaultOwnerVerifier(() => readExternalVaultFile(ownerKeyPath, excluded, false, 8192)),
    undefined, undefined, () => controllerRestoreBoundary(paths.databasePath).createdAt);
  return new DevVaultOperations(service, lifecycle);
}
