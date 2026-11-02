export const authenticationProvider = {
  contractVersion: 4, providerId: "better-auth", implementationVersion: "1", storageRevision: 2,
  create(host) { globalThis.__loaderProbe = { host }; throw new Error("fixture-secret-should-not-leak"); },
};
