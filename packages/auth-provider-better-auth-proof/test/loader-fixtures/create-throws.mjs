export const authenticationProvider = {
  contractVersion: 2, providerId: "better-auth", implementationVersion: "1", storageRevision: 1,
  create(host) { globalThis.__loaderProbe = { host }; throw new Error("fixture-secret-should-not-leak"); },
};
