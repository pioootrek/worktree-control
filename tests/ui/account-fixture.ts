import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Page } from "@playwright/test";

/**
 * Static-export fixture for the closed account mode. It stubs the closed
 * `/api/auth/*`, scoped `/api/runtime/*` and cookie `/api/knowledge` routes in
 * Node and serves the real built export; no listener or controller runs. The
 * session is simulated fixture-side, so the spec asserts what the GUI sends
 * (never a bearer, token or CSRF value) and how it renders each answer. Real
 * cookie semantics are covered by the HTTPS browser test with the controller.
 */

export interface AccountFixtureOptions {
  email?: string;
  password?: string;
  /** A TOTP enrolment on the account turns password sign-in into a challenge. */
  totpCode?: string;
  /** Start with a valid session, as after a reload with a live cookie. */
  preAuthenticated?: boolean;
  /** Offer passkey routes; a mocked navigator.credentials completes the ceremony. */
  passkey?: boolean;
  /** Report no login surface, as in open/token mode; the legacy dashboard renders. */
  loginAvailable?: boolean;
  runtimeRead?: (body: Record<string, unknown>) => { status?: number; json: unknown };
  runtimeMutate?: (body: Record<string, unknown>) => { status?: number; json: unknown };
  runtimeTests?: (body: Record<string, unknown>) => { status?: number; json: unknown };
  runtimeConfiguration?: (body: Record<string, unknown>) => { status?: number; json: unknown };
  knowledge?: (body: Record<string, unknown>) => { status?: number; json: unknown };
}

export interface AccountFixture {
  requests: Array<{ path: string; method: string; body: unknown; authorization: string | null }>;
  errors: string[];
  /** Simulated session; set null to model expiry or revocation mid-test. */
  session: null | {
    principal: { id: string; kind: "owner" | "human" };
    expiresAt: string;
    authentication: { method: "password"; factors: 1 } | { method: "password_totp"; factors: 2 } | { method: "passkey_uv"; factors: 2 };
  };
  establish(): void;
}

const worktreePath = "/fixture/web";

const defaultSummary = {
  id: "web", name: "Fixture Web", port: 3000, phase: "stopped" as const,
  actions: ["projects:read", "claims:manage", "runtime:control", "tests:run", "profiles:select", "config:write"],
  worktreePath: null, claim: "none" as const,
};
const defaultStatus = {
  ...defaultSummary, selectedWorktreePath: worktreePath, startedAt: null, managedServer: true, ownClaim: null,
};
const defaultWorktrees = [{ path: worktreePath, branch: "main", head: "abcdef123456", shortHead: "abcdef1", detached: false, locked: false, prunable: false, dirty: false }];

function defaultRuntimeRead(body: Record<string, unknown>): { status?: number; json: unknown } {
  if (body.operation === "list-projects") return { json: { operation: "list-projects", projects: [defaultSummary] } };
  if (body.operation === "project-status") return { json: { operation: "project-status", status: defaultStatus } };
  if (body.operation === "list-worktrees") return { json: { operation: "list-worktrees", worktrees: defaultWorktrees } };
  return { status: 400, json: { code: "invalid_request", error: "Unknown fixture operation" } };
}

function defaultKnowledge(body: Record<string, unknown>): { status?: number; json: unknown } {
  const project = { id: "shared", name: "Shared knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  if (body.operation === "projects") return { json: { items: [project], nextOffset: null } };
  if (body.operation === "project") return { json: project };
  return { json: { items: [], nextOffset: null, total: 0, counts: { active: 0, now: 0, next: 0, blocked: 0, done: 0, all: 0 } } };
}

/** Loads the real static export into Chromium against the closed account API fixture. */
export async function mountAccount(page: Page, options: AccountFixtureOptions = {}): Promise<AccountFixture> {
  const origin = "http://localhost";
  const webRoot = resolve("out");
  if (!existsSync(resolve(webRoot, "index.html"))) throw new Error("Run pnpm build before pnpm test:ui.");
  const email = options.email ?? "user@example.com";
  const password = options.password ?? "fixture-password";
  const fixture: AccountFixture = {
    requests: [],
    errors: [],
    session: null,
    establish() {
      fixture.session = {
        principal: { id: "acct-1", kind: "human" },
        expiresAt: "2030-01-01T00:00:00.000Z",
        authentication: options.totpCode ? { method: "password_totp", factors: 2 } : { method: "password", factors: 1 },
      };
    },
  };
  if (options.preAuthenticated) fixture.establish();
  let totpPending = false;
  page.on("pageerror", error => fixture.errors.push(error.message));

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const request = route.request();
      const body = request.method() === "POST" ? request.postDataJSON() : null;
      fixture.requests.push({ path: url.pathname, method: request.method(), body, authorization: request.headers()["authorization"] ?? null });
      const fail = (status: number, code: string) => route.fulfill({ status, json: { code, error: `Fixture ${code}` } });
      const requireSession = () => {
        if (fixture.session) return false;
        void fail(401, "invalid_credential");
        return true;
      };
      switch (url.pathname) {
        case "/api/auth/status":
          return route.fulfill({ json: { mode: options.loginAvailable === false ? "open" : "better-auth", loginAvailable: options.loginAvailable !== false } });
        case "/api/auth/get-session":
          return route.fulfill({ json: fixture.session ? { authenticated: true, ...fixture.session } : { authenticated: false } });
        case "/api/auth/sign-in/email": {
          if (body?.email !== email || body?.password !== password) return fail(401, "invalid_credential");
          if (options.totpCode) { totpPending = true; return route.fulfill({ json: { authenticated: false, outcome: "challenge", method: "totp" } }); }
          fixture.establish();
          return route.fulfill({ json: { authenticated: true } });
        }
        case "/api/auth/two-factor/verify-totp": {
          if (body?.code !== options.totpCode) return fail(401, "authentication_failed");
          if (totpPending) { totpPending = false; fixture.establish(); return route.fulfill({ json: { authenticated: true } }); }
          // Enrollment confirmation selects the method and ends every session.
          fixture.session = null;
          return route.fulfill({ json: { outcome: "enrolled", authorizing: false } });
        }
        case "/api/auth/two-factor/enable":
          if (requireSession()) return;
          if (body?.password !== password) return fail(401, "invalid_credential");
          return route.fulfill({ json: { outcome: "enrollment", totpURI: "otpauth://totp/Worktree%20Control:user?secret=FIXTURESECRET&issuer=Worktree%20Control", authorizing: false } });
        case "/api/auth/change-password":
          if (requireSession()) return;
          if (body?.currentPassword !== password) return fail(401, "invalid_credential");
          return route.fulfill({ json: { changed: true } });
        case "/api/auth/sign-out":
          fixture.session = null;
          return route.fulfill({ json: { authenticated: false } });
        case "/api/auth/passkey/generate-authenticate-options":
          if (!options.passkey) return fail(401, "authentication_failed");
          return route.fulfill({ json: { outcome: "options", options: { challenge: "Y2hhbGxlbmdl", rpId: "localhost", userVerification: "required" } } });
        case "/api/auth/passkey/verify-authentication":
          if (!options.passkey) return fail(401, "authentication_failed");
          fixture.session = { principal: { id: "acct-1", kind: "human" }, expiresAt: "2030-01-01T00:00:00.000Z", authentication: { method: "passkey_uv", factors: 2 } };
          return route.fulfill({ json: { authenticated: true } });
        case "/api/auth/passkey/generate-register-options":
          if (requireSession()) return;
          if (!options.passkey) return fail(401, "authentication_failed");
          return route.fulfill({ json: { outcome: "options", options: {
            rp: { id: "localhost", name: "Worktree Control" }, user: { id: "YWNjdC0x", name: email, displayName: "Fixture User" },
            challenge: "Y2hhbGxlbmdl", pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [],
            authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" }, attestation: "none",
          } } });
        case "/api/auth/passkey/verify-registration":
          if (requireSession()) return;
          if (!options.passkey) return fail(401, "authentication_failed");
          return route.fulfill({ json: { outcome: "staged", authorizing: false } });
        case "/api/auth/passkey/generate-confirm-options":
          if (requireSession()) return;
          if (!options.passkey) return fail(401, "authentication_failed");
          return route.fulfill({ json: { outcome: "options", options: { challenge: "Y2hhbGxlbmdl", rpId: "localhost", userVerification: "required" } } });
        case "/api/auth/passkey/verify-confirmation":
          if (!options.passkey) return fail(401, "authentication_failed");
          fixture.session = null;
          return route.fulfill({ json: { outcome: "enrolled", authorizing: false } });
        case "/api/runtime/read": {
          if (requireSession()) return;
          const answer = (options.runtimeRead ?? defaultRuntimeRead)(body ?? {});
          return route.fulfill({ status: answer.status ?? 200, json: answer.json });
        }
        case "/api/runtime/mutate": {
          if (requireSession()) return;
          const answer = options.runtimeMutate ? options.runtimeMutate(body ?? {}) : { status: 400, json: { code: "invalid_request", error: "Unconfigured fixture mutation" } };
          return route.fulfill({ status: answer.status ?? 200, json: answer.json });
        }
        case "/api/runtime/tests": {
          if (requireSession()) return;
          const answer = options.runtimeTests ? options.runtimeTests(body ?? {}) : { status: 400, json: { code: "invalid_request", error: "Unconfigured fixture test operation" } };
          return route.fulfill({ status: answer.status ?? 200, json: answer.json });
        }
        case "/api/runtime/configuration": {
          if (requireSession()) return;
          const answer = options.runtimeConfiguration ? options.runtimeConfiguration(body ?? {}) : { status: 400, json: { code: "invalid_request", error: "Unconfigured fixture configuration" } };
          return route.fulfill({ status: answer.status ?? 200, json: answer.json });
        }
        case "/api/knowledge": {
          if (requireSession()) return;
          const answer = (options.knowledge ?? defaultKnowledge)(body ?? {});
          return route.fulfill({ status: answer.status ?? 200, json: answer.json });
        }
        default:
          return fail(404, "invalid_request");
      }
    }
    const file = resolve(webRoot, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
    if (!file.startsWith(webRoot + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: "Missing static asset" });
    return route.fulfill({ path: file });
  });
  await page.goto(`${origin}/`);
  return fixture;
}

/** A minimal platform credential API so passkey flows run without a secure origin or authenticator. */
export async function mockWebAuthn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bytes = (value: string) => Uint8Array.from(value, character => character.charCodeAt(0)).buffer;
    const credential = {
      id: "Y3JlZA",
      rawId: bytes("cred"),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes("client"),
        attestationObject: bytes("attestation"),
        authenticatorData: bytes("auth"),
        signature: bytes("signature"),
        userHandle: bytes("acct-1"),
        getTransports: () => ["internal"],
        getPublicKey: () => null,
        getPublicKeyAlgorithm: () => -7,
        getAuthenticatorData: () => null,
      },
    };
    Object.defineProperty(window, "isSecureContext", { get: () => true, configurable: true });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: () => Promise.resolve(credential),
        get: () => Promise.resolve(credential),
      },
    });
    if (typeof window.PublicKeyCredential !== "function") {
      Object.assign(window, { PublicKeyCredential: function PublicKeyCredential() { /* marker */ } });
    }
  });
}
