export const authenticationProvider = {
  contractVersion: 3, providerId: "better-auth", implementationVersion: "1", storageRevision: 2,
  create(host) {
    const probe = globalThis.__loaderProbe = { host, disposed: 0 };
    return { initialize: async () => ({}), dispose: async () => { probe.disposed++; } };
  },
};
