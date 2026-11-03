export const authenticationProvider = {
  contractVersion: 5, providerId: "better-auth", implementationVersion: "1", storageRevision: 3,
  create(host) { globalThis.__loaderProbe = { host }; throw new Error("fixture-secret-should-not-leak"); },
};
