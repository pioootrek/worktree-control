export const authenticationProvider = {
  contractVersion: 1, providerId: "better-auth", implementationVersion: "1", storageRevision: 1,
  create(host) {
    const probe = globalThis.__loaderProbe = { host, disposed: 0 };
    return { dispose() { probe.disposed++; throw new Error("fixture-secret partial disposal"); } };
  },
};
