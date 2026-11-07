import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { AuthenticationProviderError, type AuthenticationProviderRuntime, type BrowserRelease } from "@/server/modules/authentication";
import { directAdmission } from "@/server/database-admission";
import { describe, expect, it, vi } from "vitest";
import { approvedAuthenticationCookies, AuthenticationHttp } from "./authentication-http";
import { BoundaryError, COOKIE_POLICY, parseStrictJson, readBoundedBody, requestCookies, validateTransportLimits } from "./authentication-http-boundary";

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
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    writeHead(status: number) { this.status = status; return this; },
    end(body: string) { this.body = JSON.parse(body); },
  });
}
const limits = { passwordBodyBytes: 4096, webAuthnBodyBytes: 32_768, knowledgeBodyBytes: 65_536, cookieBytes: 8192, bodyTimeoutMs: 10_000,
  json: { maxDepth: 8, maxFields: 64 }, knowledgeJson: { maxDepth: 16, maxFields: 1024 }, reservedCompletionSlots: 0 };
function adapter(assertAvailable?: () => void) {
  const release = Object.freeze({ operation: "sign-out", outcome: "signed-out" }) as BrowserRelease;
  const browser = vi.fn<AuthenticationProviderRuntime["browser"]>().mockImplementation(() => ({ result: Promise.resolve(release), settled: Promise.resolve() }));
  const value = new AuthenticationHttp({ origin: "https://controller.test", admission: directAdmission, limits, assertAvailable,
    runtime: { browser, browserReleaseHeaders: () => new Headers(), browserReleaseCommitted: () => false, discardBrowserRelease: () => ({ result: Promise.resolve(), settled: Promise.resolve() }),
      finishBrowserRelease: () => ({ authenticated: false }) } as never, knowledge: {} as never, status: () => ({ mode: "open", loginAvailable: true }), maxInFlight: 1 });
  return { value, browser };
}
describe("authentication request lifetime and socket peer", () => {
  it.each(["maintenance", "provider_configuration_restart_required"])("reports unavailable guarded composition without calling the provider: %s", async code => {
    const f = adapter(() => { throw new AuthenticationProviderError(code, "private configuration detail"); }), response = outgoing();
    await f.value.handle(incoming("127.0.0.1") as never, response as never);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "database_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("private configuration detail");
    expect(f.browser).not.toHaveBeenCalled();
    response.emit("finish");
  });

  it("closes a partially sent response without attempting a replacement error write", async () => {
    const f = adapter(), response = Object.assign(outgoing(), { headersSent: false, destroy: vi.fn() });
    response.destroy.mockImplementation(() => { response.destroyed = true; response.emit("close"); });
    const writes = vi.spyOn(response, "writeHead").mockImplementation(() => {
      response.headersSent = true;
      throw new Error("fixture partial response");
    });
    await expect(f.value.handle(incoming("127.0.0.1") as never, response as never)).resolves.toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(response.destroy).toHaveBeenCalledOnce();
  });

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

describe("strict JSON", () => {
  const ceiling = { maxDepth: 3, maxFields: 4 };
  it("returns ordinary JSON", () => { expect(parseStrictJson(' {"a": [1, {"b": "\\"}"}], "c": null} ', ceiling)).toEqual({ a: [1, { b: '"}' }], c: null }); });
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '[{"a":1,"a":2}]', "[[[[1]]]]", '{"a":1,"b":2,"c":3,"d":4,"e":5}', "", "{", "nope",
  ])("refuses %s", text => { expect(() => parseStrictJson(text, ceiling)).toThrow(BoundaryError); });
  it("allows the same key in different objects", () => { expect(parseStrictJson('[{"a":1},{"a":2}]', ceiling)).toEqual([{ a: 1 }, { a: 2 }]); });
});

describe("bounded body", () => {
  const body = (chunks: Buffer[], headers: Record<string, string> = {}) => Object.assign(Readable.from(chunks), { headers }) as never;
  const read = (request: never, limit = 8) => readBoundedBody(request, { limit, timeoutMs: 1000, signal: new AbortController().signal });
  it("returns exactly the limit and refuses one more byte, whatever Content-Length claims", async () => {
    await expect(read(body([Buffer.from("12345678")]))).resolves.toBe("12345678");
    await expect(read(body([Buffer.from("1234"), Buffer.from("56789")]))).rejects.toMatchObject({ status: 413 });
    await expect(read(body([Buffer.from("123456789")], { "content-length": "1" }))).rejects.toMatchObject({ status: 413 });
    await expect(read(body([], { "content-length": "9" }))).rejects.toMatchObject({ status: 413 });
  });
  it("decodes a character split across chunks and refuses invalid UTF-8", async () => {
    const word = Buffer.from("ż");
    await expect(read(body([word.subarray(0, 1), word.subarray(1)]))).resolves.toBe("ż");
    await expect(read(body([word.subarray(0, 1)]))).rejects.toMatchObject({ status: 400 });
  });
  it("refuses any Content-Encoding, and a byte-order mark never reaches JSON", async () => {
    await expect((async () => read(body([], { "content-encoding": "identity" })))()).rejects.toMatchObject({ status: 400 });
    expect(() => parseStrictJson("\uFEFF{}", { maxDepth: 1, maxFields: 1 })).toThrow(BoundaryError);
  });
  it("ends on cancellation and removes its listeners", async () => {
    const request = Object.assign(new Readable({ read() {} }), { headers: {} }) as unknown as never, abort = new AbortController();
    const pending = readBoundedBody(request, { limit: 8, timeoutMs: 1000, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(BoundaryError);
    expect((request as unknown as Readable).listenerCount("data")).toBe(0);
  });
});

describe("cookie operation matrix", () => {
  const S = "__Secure-wtc.session_token", T = "__Secure-wtc.two_factor", P = "__Secure-wtc.passkey_challenge";
  it("reads exactly the managed cookies and ignores unrelated ones", () => {
    expect([...requestCookies(`theme=dark; ${S}=a; __Secure-wtc.trust_device=x; ${P}=b`)]).toEqual([[S, "a"], [P, "b"]]);
  });
  it.each([`${S}=a; ${S}=b`, `${T}=a; ${T}=a`, `wtc.session_token=a`, `__secure-wtc.two_factor=a`, `__SECURE-WTC.PASSKEY_CHALLENGE=a`])("refuses %s", header => {
    expect(() => requestCookies(header)).toThrow(BoundaryError);
  });
  it("gives every operation an explicit row and forwards T or P only where they are used", () => {
    expect(COOKIE_POLICY["sign-in"].forward).toEqual([]);
    expect(COOKIE_POLICY["passkey-authenticate-options"].forward).toEqual([]);
    expect(COOKIE_POLICY["passkey-authentication"].forward).toEqual([P]);
    expect(COOKIE_POLICY["totp-enable"].live).toEqual([]);
    expect(COOKIE_POLICY["passkey-confirmation"].live).toEqual([]);
    expect(COOKIE_POLICY["sign-out"].live).toEqual([]);
  });
  const live = (name: string, attributes = "Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300") => new Headers({ "set-cookie": `${name}=value; ${attributes}` });
  it("accepts only the live names an operation allows, and trust-device only as a deletion", () => {
    expect(approvedAuthenticationCookies(live(T), [T])).toHaveLength(1);
    expect(() => approvedAuthenticationCookies(live(T), [S])).toThrow("provider_failed");
    expect(() => approvedAuthenticationCookies(live("__Secure-wtc.trust_device"), [S, T, P])).toThrow("provider_failed");
    expect(approvedAuthenticationCookies(new Headers({ "set-cookie": "__Secure-wtc.trust_device=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" }), [])).toHaveLength(1);
  });
  it("refuses a lifetime beyond the approved one", () => {
    expect(() => approvedAuthenticationCookies(live(P, "Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3601"), [P])).toThrow("provider_failed");
    expect(() => approvedAuthenticationCookies(live(S, "Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28801"))).toThrow("provider_failed");
  });
});

describe("transport limits", () => {
  it.each([undefined, {}, { ...limits, passwordBodyBytes: 0 }, { ...limits, json: { maxDepth: 1 } }, { ...limits, reservedCompletionSlots: 8 }, { ...limits, reservedCompletionSlots: -1 }])("has no defaults for %j", value => {
    expect(() => validateTransportLimits(value as never, 8)).toThrow("Invalid authentication transport limits.");
  });
  it("freezes explicit limits", () => { expect(Object.isFrozen(validateTransportLimits(limits, 8).json)).toBe(true); });
});
