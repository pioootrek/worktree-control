import { describe, expect, it } from "vitest";
import { approvedAuthenticationCookies, AuthenticationHttp } from "./authentication-http";

const safe = "__Secure-wtc.session_token=fixture-cookie; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800";
describe("authentication cookie boundary", () => {
  it("preserves complete independent Set-Cookie lines including an Expires comma", () => {
    const headers = new Headers(); headers.append("set-cookie", safe);
    headers.append("set-cookie", "__Secure-wtc.session_data=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(approvedAuthenticationCookies(headers)).toHaveLength(2);
  });
  it.each([
    safe + "; Domain=controller.test", safe + "; Location=https://sentinel.invalid", safe.replace("Secure; ", ""),
    safe.replace("HttpOnly; ", ""), safe.replace("Strict", "None"), safe.replace("Path=/", "Path=/api"),
    safe.replace("__Secure-wtc.session_token", "arbitrary"), safe + "; Secure", safe.replace("28800", "NaN"),
    safe.replace("__Secure-wtc.session_token", "__Secure-wtc.session_data"),
  ])("rejects unsafe cookie attributes and unapproved names: %s", line => {
    const headers = new Headers({ "set-cookie": line });
    expect(() => approvedAuthenticationCookies(headers)).toThrow("provider_failed");
  });
  it("requires an exact canonical HTTPS origin before composition", () => {
    for (const origin of ["http://localhost", "https://user@controller.test", "https://controller.test/", "https://controller.test/api/auth"]) {
      expect(() => new AuthenticationHttp({ origin } as never)).toThrow();
    }
  });
});
