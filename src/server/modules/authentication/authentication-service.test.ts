import { describe, expect, it } from "vitest";

import { AuthenticationError, AuthenticationService, type AuthenticationMode, type AuthenticationPolicy, type AuthenticationStore } from ".";

const NOW = "2026-09-26T12:00:00.000Z";

function memoryStore(initial: AuthenticationPolicy = { mode: "legacy", token: null, generation: 0 }) {
  let policy = initial;
  const events: Array<{ event: string; actor: string; policy: AuthenticationPolicy }> = [];
  const store: AuthenticationStore = {
    getAuthenticationPolicy: () => policy,
    saveAuthenticationPolicy: (next, event, actor) => {
      policy = next;
      events.push({ event, actor, policy: next });
    },
  };
  return { store, events, current: () => policy };
}

function service(store: AuthenticationStore, enforced: AuthenticationMode[] = ["legacy"]) {
  let counter = 0;
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  return new AuthenticationService(
    store,
    () => NOW,
    () => ids[counter++]!,
    () => String(counter).repeat(64),
    new Set(enforced),
  );
}

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AuthenticationError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
}

describe("installation authentication policy", () => {
  it("retains distinct individual agent and dedicated worker credentials in RBAC while closing owner and shared bearers", () => {
    const auth = new AuthenticationService(memoryStore({ mode: "better-auth", token: null, generation: 0 }).store);
    const actor = { principalId: "individual", credentialId: "credential" };
    expect(auth.permitsCredential({ ...actor, principalKind: "agent", authenticationMethod: "agent_token" })).toBe(true);
    expect(auth.permitsCredential({ ...actor, principalKind: "worker", authenticationMethod: "worker_token" })).toBe(true);
    expect(auth.permitsCredential({ ...actor, principalKind: "owner", authenticationMethod: "owner_session" })).toBe(false);
    expect(auth.permitsCredential({ ...actor, principalKind: "installation", authenticationMethod: "installation_token" })).toBe(false);
  });
  it("generates the installation token once and persists only its verifier", () => {
    const memory = memoryStore();
    const auth = service(memory.store);

    const issued = auth.generateToken("local-cli");

    expect(issued.token).toBe(`wsi_11111111-1111-4111-8111-111111111111_${"1".repeat(64)}`);
    expect(issued.status).toEqual({
      mode: "legacy", activeMode: "legacy", configuredMode: "legacy", restartRequired: false,
      token: { id: "11111111-1111-4111-8111-111111111111", prefix: "wsi_11111111-1111-4111-8111-111111111111", createdAt: NOW },
      generation: 1,
    });
    expect(JSON.stringify(memory.current())).not.toContain("1".repeat(64));
    expect(JSON.stringify(auth.status())).not.toContain("verifier");
    expect(code(() => auth.generateToken("local-cli"))).toBe("installation_token_exists");
    expect(memory.current().generation).toBe(1);
  });

  it("verifies only the current token and rejects it after rotation", () => {
    const memory = memoryStore();
    const auth = service(memory.store);
    const first = auth.generateToken("local-cli").token;
    expect(auth.verifyInstallationToken(first)).toBe(true);
    expect(auth.verifyInstallationToken(`${first.slice(0, -1)}0`)).toBe(false);
    expect(auth.verifyInstallationToken("not-a-token")).toBe(false);

    const second = auth.rotateToken("local-cli");

    expect(second.status.generation).toBe(2);
    expect(auth.verifyInstallationToken(first)).toBe(false);
    expect(auth.verifyInstallationToken(second.token)).toBe(true);
    expect(memory.events.map(({ event }) => event)).toEqual([
      "authentication.token_generated", "authentication.token_rotated",
    ]);
  });

  it("requires an existing token before rotation and rejects every token without one", () => {
    const auth = service(memoryStore().store);
    expect(code(() => auth.rotateToken("local-cli"))).toBe("installation_token_missing");
    expect(auth.verifyInstallationToken(`wsi_11111111-1111-4111-8111-111111111111_${"1".repeat(64)}`)).toBe(false);
  });

  it("reports Better Auth as unavailable and keeps the active mode", () => {
    const memory = memoryStore();
    const auth = service(memory.store, ["legacy", "token", "open"]);

    const failure = (() => {
      try { auth.setMode("better-auth", "local-cli"); } catch (error) { return error as AuthenticationError; }
      return null;
    })();

    expect(failure?.code).toBe("auth_provider_unavailable");
    expect(failure?.message).toBe("Account authentication is unavailable.");
    expect(memory.current().mode).toBe("legacy");
    expect(memory.events).toEqual([]);
  });

  it("refuses modes without enforcement, unknown modes and a return to legacy", () => {
    const memory = memoryStore();
    const auth = service(memory.store);
    auth.generateToken("local-cli");

    expect(code(() => auth.setMode("token", "local-cli"))).toBe("auth_mode_unavailable");
    expect(code(() => auth.setMode("open", "local-cli"))).toBe("auth_mode_unavailable");
    expect(code(() => auth.setMode("legacy", "local-cli"))).toBe("invalid_request");
    expect(code(() => auth.setMode("root", "local-cli"))).toBe("invalid_request");
    expect(memory.current().mode).toBe("legacy");
  });

  it("selects token mode only after a token exists once the mode is enforced", () => {
    const memory = memoryStore();
    const auth = service(memory.store, ["legacy", "token"]);

    expect(code(() => auth.setMode("token", "local-cli"))).toBe("installation_token_missing");
    auth.generateToken("local-cli");
    expect(auth.setMode("token", "local-cli")).toMatchObject({ mode: "legacy", configuredMode: "token", restartRequired: true });
    expect(memory.events.at(-1)).toMatchObject({ event: "authentication.mode_selected", actor: "local-cli" });
    expect(auth.setMode("token", "local-cli")).toMatchObject({ mode: "legacy", configuredMode: "token", restartRequired: true });
    expect(memory.events).toHaveLength(2);
  });

  it("fails startup closed for unavailable, unenforced or incomplete policies", () => {
    expect(service(memoryStore().store).assertStartupPolicy().mode).toBe("legacy");
    expect(code(() => service(memoryStore({ mode: "better-auth", token: null, generation: 0 }).store).assertStartupPolicy()))
      .toBe("auth_provider_unavailable");
    expect(code(() => service(memoryStore({ mode: "open", token: null, generation: 0 }).store).assertStartupPolicy()))
      .toBe("auth_mode_unavailable");
    expect(code(() => service(memoryStore({ mode: "token", token: null, generation: 0 }).store, ["legacy", "token"]).assertStartupPolicy()))
      .toBe("installation_token_missing");
  });

  it("authenticates the installation actor only in token mode and only with the current token", () => {
    const memory = memoryStore();
    let auth = service(memory.store, ["legacy", "token"]);
    const first = auth.generateToken("local-cli").token;
    expect(auth.authenticateInstallation(first)).toBeNull();

    auth.setMode("token", "local-cli");
    expect(auth.authenticateInstallation(first)).toBeNull();
    auth = service(memory.store, ["legacy", "token"]);
    const actor = auth.authenticateInstallation(first);
    expect(actor).toEqual({
      principalId: "installation",
      principalKind: "installation",
      credentialId: "11111111-1111-4111-8111-111111111111",
      authenticationMethod: "installation_token",
    });
    expect(auth.isCurrentInstallationActor(actor!)).toBe(true);
    expect(auth.isCurrentInstallationActor({ ...actor!, principalKind: "owner" })).toBe(false);

    new AuthenticationService(memory.store).rotateToken("local-cli");
    expect(auth.authenticateInstallation(first)).toBeNull();
    expect(auth.isCurrentInstallationActor(actor!)).toBe(false);
  });

  it("selects open mode without a token and treats its anonymous actor as current only while open", () => {
    const memory = memoryStore();
    let auth = service(memory.store, ["legacy", "token", "open"]);
    expect(auth.anonymousInstallation()).toBeNull();

    expect(auth.setMode("open", "local-cli")).toMatchObject({ mode: "legacy", configuredMode: "open" });
    auth = service(memory.store, ["legacy", "token", "open"]);
    const anonymous = auth.anonymousInstallation()!;
    expect(anonymous).toEqual({ principalId: "installation", principalKind: "installation", credentialId: "open", authenticationMethod: "none" });
    expect(auth.isCurrentInstallationActor(anonymous)).toBe(true);
    expect(auth.authenticateInstallation(auth.generateToken("local-cli").token)).toBeNull();

    auth.setMode("token", "local-cli");
    expect(auth.isCurrentInstallationActor(anonymous)).toBe(true);
    auth = service(memory.store, ["legacy", "token", "open"]);
    expect(auth.anonymousInstallation()).toBeNull();
    expect(auth.isCurrentInstallationActor(anonymous)).toBe(false);
  });
});

describe("configured versus boot authority", () => {
  it("cancels a pending selection, treats a repeated selection as a no-op and keeps generation for credentials", () => {
    const m = memoryStore({ mode: "token", token: null, generation: 0 }), auth = new AuthenticationService(m.store);
    auth.generateToken("fixture");
    expect(auth.setMode("open", "fixture")).toMatchObject({ mode: "token", activeMode: "token", configuredMode: "open", restartRequired: true, generation: 1 });
    auth.setMode("open", "fixture");
    expect(m.events).toHaveLength(2);
    expect(auth.setMode("token", "fixture")).toMatchObject({ mode: "token", configuredMode: "token", restartRequired: false, generation: 1 });
    expect(m.events).toHaveLength(3);
    const offline = new AuthenticationService(m.store, undefined, undefined, undefined, undefined, "offline");
    expect(offline.setMode("open", "fixture")).toMatchObject({ mode: "open", activeMode: null, configuredMode: "open", restartRequired: false });
    expect(auth.mode()).toBe("token");
  });

  it("leaves boot mode, selection and audit unchanged when persistence fails", () => {
    const m = memoryStore({ mode: "open", token: null, generation: 0 });
    const auth = new AuthenticationService({ ...m.store, saveAuthenticationPolicy() { throw new Error("write refused"); } });
    expect(() => auth.setMode("better-auth", "fixture")).toThrow("Account authentication");
    expect(() => auth.setMode("token", "fixture")).toThrow("auth token generate");
    const config = new AuthenticationService(m.store); config.generateToken("fixture");
    const before = m.current(), audit = [...m.events];
    expect(() => auth.setMode("token", "fixture")).toThrow("write refused");
    expect(m.current()).toEqual(before); expect(m.events).toEqual(audit);
    expect(auth.status()).toMatchObject({ activeMode: "open", configuredMode: "open", restartRequired: false });
  });

  it.each(["id", "prefix", "verifierHash", "createdAt"] as const)("refuses malformed token %s before startup or selection without repairing it", field => {
    const m = memoryStore({ mode: "token", token: null, generation: 0 });
    const auth = new AuthenticationService(m.store); auth.generateToken("fixture");
    const valid = m.current();
    m.store.saveAuthenticationPolicy({ ...valid, token: { ...valid.token!, [field]: "invalid" } }, "fixture", "fixture");
    const audit = [...m.events];
    expect(() => new AuthenticationService(m.store)).toThrow("Stored authentication policy is invalid");
    expect(() => auth.setMode("open", "fixture")).toThrow("Stored authentication policy is invalid");
    expect(m.events).toEqual(audit); expect(auth.mode()).toBe("token");
  });
});
