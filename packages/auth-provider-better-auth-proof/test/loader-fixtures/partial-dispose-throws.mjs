export const authenticationProvider = {
  contractVersion: 5, providerId: "better-auth", implementationVersion: "1", storageRevision: 3,
  create(host) {
    const probe = globalThis.__loaderProbe = { host, disposed: 0 };
    return { dispose() { probe.disposed++; throw new Error("fixture-secret partial disposal"); } };
  },
};
