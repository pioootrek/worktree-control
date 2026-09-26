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
  it("generates the installation token once and persists only its verifier", () => {
    const memory = memoryStore();
    const auth = service(memory.store);

    const issued = auth.generateToken("local-cli");

    expect(issued.token).toBe(`wsi_11111111-1111-4111-8111-111111111111_${"1".repeat(64)}`);
    expect(issued.status).toEqual({
      mode: "legacy",
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
    expect(failure?.message).toBe("Better Auth: to be implemented soon.");
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
    expect(auth.setMode("token", "local-cli").mode).toBe("token");
    expect(memory.events.at(-1)).toMatchObject({ event: "authentication.mode_changed", actor: "local-cli" });
    expect(auth.setMode("token", "local-cli").mode).toBe("token");
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
});
