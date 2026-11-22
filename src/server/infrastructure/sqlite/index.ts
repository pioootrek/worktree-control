export { SqliteStateStore } from "./sqlite-state-store";
export { verifyBackupSnapshot } from "./verify-backup-snapshot";
export { OwnedSqliteDatabase, acquireDatabaseOwnership } from "./owned-database";
export { inspectSchema, snapshotAttachments, SUPPORTED_SCHEMA_VERSION } from "./schema-inspection";
export { hashFile, parseManifest, readBoundedJson, syncTree, validateBackup, validateBackupFiles, ensureStagingCapacity, stageVerifiedBackup, BACKUP_LIMITS, sha256Schema, type ControllerBackupManifest } from "./backup-validation";
export { getOwnedRestoreStatus, prepareOwnedRestore, recoverOwnedRestore, restoreActorSchema, restoreRoot, type RestoreActor } from "./restore-recovery";
export { openRemoteRecoveryInspection } from "./remote-connection-inspection";

export { SecurityFence, SecurityFenceBackupError, SecurityFenceError, securityRecoveryBoundary } from "./security-fence";
export { loadOperationKey, OperationKeyError, operationKeyPath } from "./operation-fingerprint-key";
export { OPERATION_IDEMPOTENCY_LIMITS, type OperationIdempotencyRepair } from "./operation-idempotency-queries";
export { establishSqliteSecurityFence, maintainSqliteSecurityFence, type SecurityMaintenanceCommand, type SecurityMaintenanceResult } from "./security-maintenance";
export type { MaintenanceBackup, MaintenanceBackupSource } from "./backup-binding";
export { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeApplyResult, type UpgradeInspection, type UpgradeStatus } from "./upgrade-maintenance";
export { UpgradeError, UPGRADE_PLAN_LIMITS, type UpgradeErrorCode, type UpgradeFindings, type UpgradeNextStep, type UpgradeState } from "./upgrade-contract";
