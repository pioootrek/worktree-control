// A contract-4 module claiming the new storage: the two checks must fail independently.
export const authenticationProvider = {
  contractVersion: 4, providerId: "better-auth", implementationVersion: "0.0.0-proof.4", storageRevision: 3,
  create() { globalThis.__legacyProviderCreated = true; throw new Error("legacy provider must not execute"); },
};
