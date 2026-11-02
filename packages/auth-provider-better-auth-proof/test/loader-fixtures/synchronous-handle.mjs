export const authenticationProvider = {
  contractVersion: 5, providerId: "better-auth", implementationVersion: "1", storageRevision: 3,
  create(host) {
    return {
      initialize() {
        return Promise.resolve({ providerId: "better-auth", implementationVersion: "1", schema: "verified", library: { name: "fixture", version: "1" } });
      },
      handle(request) {
        if (new URL(request.url).pathname === "/transaction") {
          host.connection.prepare("BEGIN").run([]);
          host.connection.prepare("INSERT INTO authentication_ba_verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('sync-failure', 'fixture', 'fixture', 'now', 'now', 'now')").run([]);
        }
        throw new Error("fixture-secret from a synchronous provider failure");
      },
      async signOut() {},
      async resolveSession() { return null; },
      async provisionLocal() { throw new Error("unused"); },
      async recoverLocal() { throw new Error("unused"); },
      async revokeSession() {},
      async revokeSubjectSessions() {},
      async dispose() {},
    };
  },
};
