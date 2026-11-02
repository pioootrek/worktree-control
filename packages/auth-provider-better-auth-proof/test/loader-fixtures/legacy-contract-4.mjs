// Frozen pre-I22 identity: contract 4, proof.4 on storage revision 2, which has no
// issuance obligation. Loading it must stop before executing provider code.
export const authenticationProvider = {
  contractVersion: 4, providerId: "better-auth", implementationVersion: "0.0.0-proof.4", storageRevision: 2,
  create() { globalThis.__legacyProviderCreated = true; throw new Error("legacy provider must not execute"); },
};
