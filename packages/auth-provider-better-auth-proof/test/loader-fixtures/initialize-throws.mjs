const methods = ["handle", "signOut", "resolveSession", "provisionLocal", "recoverLocal", "revokeSession", "revokeSubjectSessions"];
export const authenticationProvider = {
  contractVersion: 5, providerId: "better-auth", implementationVersion: "1", storageRevision: 3,
  create(host) {
    const probe = globalThis.__loaderProbe = { host, disposed: 0, statements: [] };
    const instance = Object.fromEntries(methods.map(name => [name, async () => { throw new Error("unused"); }]));
    instance.initialize = async () => {
      probe.statements.push(host.connection.prepare("SELECT 1 one"));
      host.connection.prepare("BEGIN").run([]);
      throw new Error("initialization failed after BEGIN");
    };
    instance.dispose = async () => { probe.disposed++; };
    return instance;
  },
};
