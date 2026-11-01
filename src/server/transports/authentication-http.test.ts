import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { directAdmission } from "@/server/database-admission";
import { describe, expect, it, vi } from "vitest";
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
    safe.replace("__Secure-wtc.session_token", "arbitrary"), safe + "; Secure", safe.replace("28800", "NaN"), safe.replace("fixture-cookie", '"unsafe"'), safe.replace("fixture-cookie", "unsafe\\cookie"),
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


function incoming(peer?: string) {
  return Object.assign(Readable.from([Buffer.from("{}")]), { url: "/api/auth/sign-out", method: "POST", headers: {
    host: "controller.test", origin: "https://controller.test", "content-type": "application/json",
  }, rawHeaders: [], socket: { remoteAddress: peer } });
}
function outgoing() {
  const headers = new Map<string, unknown>();
  return Object.assign(new EventEmitter(), { headers, status: 0, body: {}, writableFinished: false, destroyed: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    writeHead(status: number) { this.status = status; return this; },
    end(body: string) { this.body = JSON.parse(body); },
  });
}
function adapter() {
  const browser = vi.fn(async (_operation: string, _request: Request) => ({ response: new Response(null), actor: null }));
  const value = new AuthenticationHttp({ origin: "https://controller.test", admission: directAdmission,
    runtime: { browser } as never, knowledge: {} as never, status: () => ({ mode: "open", loginAvailable: true }), maxInFlight: 1 });
  return { value, browser };
}
describe("authentication request lifetime and socket peer", () => {
  it.each([undefined, "not-an-address"])("fails closed without a valid socket peer: %s", async peer => {
    const f = adapter(), response = outgoing();
    await f.value.handle(incoming(peer) as never, response as never);
    expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1"); expect(f.browser).not.toHaveBeenCalled();
    response.emit("finish");
  });
  it("holds capacity until both provider completion and external response completion", async () => {
    const f = adapter(), response = outgoing();
    await f.value.handle(incoming("::ffff:127.0.0.1") as never, response as never);
    expect(response.status).toBe(200);
    expect(f.browser.mock.calls[0]?.[1].headers.get("x-worktree-control-client-ip")).toBe("127.0.0.1");
    const refused = outgoing();
    await f.value.handle(incoming("127.0.0.1") as never, refused as never);
    expect(refused.status).toBe(503); expect(f.browser).toHaveBeenCalledOnce();
    response.emit("finish");
    const next = outgoing(); await f.value.handle(incoming("127.0.0.1") as never, next as never);
    expect(next.status).toBe(200); expect(f.browser).toHaveBeenCalledTimes(2); next.emit("finish");
  });
});
