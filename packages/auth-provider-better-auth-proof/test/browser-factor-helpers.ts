import { expect, vi } from "vitest";
import { aroundBrowser, type BrowserClient, type BrowserFixture, type HttpResult } from "./browser-authentication-fixture";
import { Authenticator } from "./factor-fixture";
import { OWNER_PASSWORD } from "./fixture";
import { advance, STEP } from "./integrated-fixture";
import { PasskeyAuthenticator, type AuthenticatorInput, type CeremonyOptions } from "./passkey-authenticator";

export const S = "__Secure-wtc.session_token", T = "__Secure-wtc.two_factor", P = "__Secure-wtc.passkey_challenge";
export const signIn = (client: BrowserClient) => client.login();
export const get = (client: BrowserClient, path: string) => client.call(`/api/auth/${path}`, { method: "GET" });
export const post = (client: BrowserClient, path: string, body: unknown) => client.call(`/api/auth/${path}`, { body });
export const options = async (client: BrowserClient, kind: "register" | "confirm" | "authenticate") => {
  // Same-origin browser GETs carry Fetch Metadata, but do not carry Origin.
  const result = await client.call(`/api/auth/passkey/generate-${kind}-options`, { method: "GET", omitOrigin: true,
    headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } });
  expect(result).toMatchObject({ status: 200, body: { outcome: "options" } });
  expect(Object.keys(result.body).sort()).toEqual(["options", "outcome"]);
  return result.body.options as unknown as CeremonyOptions;
};
/** Sets the jar from nothing but what a response released. No cookie is ever written by hand. */
export const live = (result: HttpResult) => (result.headers["set-cookie"] ?? []).filter(line => !/max-age=0/i.test(line));
export const deleted = (result: HttpResult) => (result.headers["set-cookie"] ?? []).filter(line => /max-age=0/i.test(line)).map(line => line.split("=")[0]);
export const refused = (result: HttpResult, status = 401, code = "authentication_failed") => {
  expect(result).toMatchObject({ status, body: { code } });
  expect(result.body).not.toHaveProperty("committed");
  expect(live(result)).toEqual([]);
};
export const strength = async (client: BrowserClient, method: string) => {
  expect(await client.session()).toMatchObject({ status: 200, body: { authenticated: true, authentication: { method, factors: method === "password" ? 1 : 2 } } });
};
export const unauthenticated = async (client: BrowserClient) => { expect((await client.session()).body).toEqual({ authenticated: false }); };

export async function enableTotp(client: BrowserClient, password = OWNER_PASSWORD) {
  const started = await post(client, "two-factor/enable", { password });
  expect(started).toMatchObject({ status: 200, body: { outcome: "enrollment", authorizing: false } });
  expect(Object.keys(started.body).sort()).toEqual(["authorizing", "outcome", "totpURI"]);
  return new Authenticator(started.body.totpURI as string);
}
export async function enrollTotp(client: BrowserClient) {
  const authenticator = await enableTotp(client);
  const finished = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
  expect(finished).toMatchObject({ status: 200, body: { outcome: "enrolled", authorizing: false } });
  expect(Object.keys(finished.body).sort()).toEqual(["authorizing", "outcome"]);
  expect(deleted(finished)).toContain(S);
  return authenticator;
}
export async function totpLogin(client: BrowserClient, authenticator: Authenticator) {
  advance(STEP * 2);
  const challenge = await signIn(client);
  expect(challenge).toMatchObject({ status: 200, body: { authenticated: false, outcome: "challenge", method: "totp" } });
  const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
  expect(result).toMatchObject({ status: 200, body: { authenticated: true } });
  return result;
}
export async function stage(client: BrowserClient, input: AuthenticatorInput = { attestationNone: true }, authenticator = new PasskeyAuthenticator()) {
  const result = await post(client, "passkey/verify-registration", { response: authenticator.register(await options(client, "register"), input) });
  expect(result).toMatchObject({ status: 200, body: { outcome: "staged", authorizing: false } });
  return authenticator;
}
export async function enrollPasskey(client: BrowserClient, input?: AuthenticatorInput) {
  const authenticator = await stage(client, input);
  const finished = await post(client, "passkey/verify-confirmation", { response: authenticator.assert(await options(client, "confirm"), { counter: 0 }) });
  expect(finished).toMatchObject({ status: 200, body: { outcome: "enrolled", authorizing: false } });
  return authenticator;
}
export async function passkeyLogin(client: BrowserClient, authenticator: PasskeyAuthenticator, input: AuthenticatorInput = {}) {
  return post(client, "passkey/verify-authentication", { response: authenticator.assert(await options(client, "authenticate"), input) });
}

/** Runs `between` after the real provider result, before the final admitted phase. */
export const betweenResultAndRelease = (f: BrowserFixture, operation: string, between: () => Promise<unknown>) => {
  const original = f.runtime.browser.bind(f.runtime);
  vi.spyOn(f.runtime, "browser").mockImplementation((...args) => {
    if (args[0] !== operation) return original(...args);
    return aroundBrowser(async () => {
      const lifetime = original(...args);
      await lifetime.result.catch(() => undefined);
      await between();
      return lifetime;
    });
  });
};
