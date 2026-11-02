export const authenticationProvider = {
  contractVersion: 3, providerId: "better-auth", implementationVersion: "1", storageRevision: 2,
  create(host) {
    const probe = globalThis.__loaderProbe = { host, disposed: 0 };
    return {
      async initialize() { throw new Error("fixture-secret initialization"); },
      async handle() {},
      async signOut() {},
      async resolveSession() {},
      async provisionLocal() {},
      async recoverLocal() {},
      async revokeSession() {},
      async revokeSubjectSessions() {},
      dispose() { probe.disposed++; throw new Error("fixture-secret synchronous disposal"); },
    };
  },
};
