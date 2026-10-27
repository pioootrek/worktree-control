export { DevVaultService, DEV_VAULT_STATE_BYTES } from "./dev-vault-service";
export { DevVaultCipher, canonicalJson } from "./crypto";
export { parseDevDotenv } from "./dotenv";
export { Ed25519DevVaultOwnerVerifier, devOwnerSigningMessage } from "./owner-proof";
export { DevVaultError } from "./contracts";
export type { DevVaultKeyProvider, DevVaultOwnerVerifier, DevVaultStore, DevVaultSnapshot } from "./contracts";
