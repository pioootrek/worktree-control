// Frozen pre-I20 identity. Loading it must stop before executing provider code.
export const authenticationProvider = {
  contractVersion: 3, providerId: "better-auth", implementationVersion: "0.0.0-proof.3", storageRevision: 2,
  create() { globalThis.__legacyProviderCreated = true; throw new Error("legacy provider must not execute"); },
};
