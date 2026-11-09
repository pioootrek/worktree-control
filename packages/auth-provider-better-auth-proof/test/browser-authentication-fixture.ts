import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { join } from "node:path";
import { expect } from "vitest";
import type { ControlService } from "@/server/control-service";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { AuthenticationService, type AuthenticationProviderRuntime, type ProviderFactorOptions } from "@/server/modules/authentication";
import { composeIsolatedBrowserAuthentication } from "@/server/bootstrap/authentication";
import type { ProofFaultInjection } from "../src/index";
import { ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, type SESSION_POLICY } from "./fixture";
import { closeStrictProof, strictProof } from "./strict-fixture";

let peerSequence = 1;
/** Explicit local test inputs, with no fixture value acting as product policy. */
export const TRANSPORT_LIMITS = { passwordBodyBytes: 4096, webAuthnBodyBytes: 32_768, knowledgeBodyBytes: 65_536, cookieBytes: 8192, bodyTimeoutMs: 10_000,
  json: { maxDepth: 8, maxFields: 64 }, knowledgeJson: { maxDepth: 16, maxFields: 1024 }, reservedCompletionSlots: 0 };
type BrowserLifetimeOf = ReturnType<AuthenticationProviderRuntime["browser"]>;
/** Wraps a real `runtime.browser` call with work done before and after it, keeping its lifetime. */
export function aroundBrowser(run: () => Promise<BrowserLifetimeOf>): BrowserLifetimeOf {
  const lifetime = run();
  const result = lifetime.then(value => value.result);
  result.catch(() => undefined);
  return { result, settled: lifetime.then(value => value.settled, () => undefined) };
}
export async function browserFixture(faults: ProofFaultInjection = {}, options = {}, maxInFlight = 8, factors?: ProviderFactorOptions, transport: typeof TRANSPORT_LIMITS = TRANSPORT_LIMITS, unreleasedSessions?: number, sessionPolicy?: typeof SESSION_POLICY) {
  const f = await strictProof(faults, options, undefined, factors, unreleasedSessions, sessionPolicy);
  const { subject } = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
  // Open is the frozen product boot mode; optional proof composition grants cookies ONLY converted Knowledge access.
  // No production selector, env switch or alternate product mode exists.
  await f.run(() => new AuthenticationService(f.store).setMode("open", "local-cli"));
  const authentication = await f.run(() => new AuthenticationService(f.store));
  let maintenance = false;
  const peer = `198.18.0.${peerSequence++}`;
  const { identity, providerKnowledge: app, browserAuthentication: adapter } = composeIsolatedBrowserAuthentication({
    store: f.store, authentication, origin: ORIGIN, runtime: f.runtime, admission: f.store.admission, maxInFlight,
    // A Unix peer has no IP. Explicitly trusted ONLY for temporary isolated fixture transport.
    trustedFixturePeer: peer, maintenance: () => maintenance, limits: transport });
  const service = { dashboard: () => { throw new Error("unconverted provider route reached installation authority"); } } as unknown as ControlService;
  const httpOptions = { service, identity, authentication, admission: f.store.admission, browserAuthentication: adapter,
    directoryBrowser: {} as DirectoryBrowser, events: new EventStream(f.store.admission),
    mcpStatus: () => ({ phase: "disabled" as const, endpoint: null, transport: "streamable-http" as const, network: "loopback" as const, authentication: "bearer" as const, activeSessions: 0 }),
    webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture" };
  const http = createControllerServer(httpOptions);
  const socketPath = join(f.root, "browser.sock");
  await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(socketPath, resolve); });
  const project = await f.run(() => f.identity.createKnowledgeProject({ name: "Browser grant" }, f.ownerActor));
  const grant = () => f.run(() => f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id,
    permissions: ["knowledge:read", "knowledge:write"] }, f.ownerActor));
  const client = () => new BrowserClient(socketPath);
  return { ...f, storage: f.store.authenticationProviderStorage(), subject, httpOptions, peer, authentication, identity, app, adapter, http, project, grant, client, setMaintenance: () => { maintenance = true; },
    close: async () => { await http.close(); await closeStrictProof(f); } };
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
export interface HttpResult { status: number; body: Record<string, unknown>; headers: import("node:http").IncomingHttpHeaders }
const COOKIE_NAMES = ["__Secure-wtc.session_token", "__Secure-wtc.two_factor", "__Secure-wtc.passkey_challenge"];
/** A real cookie jar: what the responses set is what the next request sends. */
export class BrowserClient {
  readonly jar = new Map<string, string>();
  constructor(readonly socketPath: string) {}
  get cookie() { const value = this.jar.get(COOKIE_NAMES[0]!); return value === undefined ? "" : `${COOKIE_NAMES[0]}=${value}`; }
  set cookie(pair: string) {
    this.jar.delete(COOKIE_NAMES[0]!);
    if (pair) this.jar.set(COOKIE_NAMES[0]!, pair.slice(pair.indexOf("=") + 1));
  }
  cookieHeader() { return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "); }
  start(path: string, init: { method?: string; body?: unknown; raw?: string; headers?: OutgoingHttpHeaders; cookie?: string; omitOrigin?: boolean } = {}) {
    let resolve!: (value: HttpResult) => void, reject!: (error: unknown) => void;
    const completed = new Promise<HttpResult>((yes, no) => { resolve = yes; reject = no; });
    const cookie = init.cookie ?? this.cookieHeader();
    const headers: OutgoingHttpHeaders = { host: "controller.test", "content-type": "application/json", connection: "close", ...(!init.omitOrigin ? { origin: ORIGIN } : {}),
      ...(cookie ? { cookie } : {}), ...init.headers };
    const call = httpRequest({ socketPath: this.socketPath, path, method: init.method ?? "POST", headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => {
        for (const line of response.headers["set-cookie"] ?? []) {
          const pair = line.split(";")[0]!, equals = pair.indexOf("="), name = pair.slice(0, equals), value = pair.slice(equals + 1);
          if (!value || /max-age=0/i.test(line)) this.jar.delete(name); else this.jar.set(name, value);
        }
        try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: response.headers }); }
        catch (error) { reject(error); }
      });
    });
    call.on("error", reject); call.flushHeaders();
    return { completed, send: (raw: string) => call.end(raw), abort: () => call.destroy(), write: (raw: string | Buffer) => call.write(raw) };
  }
  async call(path: string, init: Parameters<BrowserClient["start"]>[1] = {}) {
    const call = this.start(path, init); call.send(init.raw ?? (init.body === undefined ? "" : JSON.stringify(init.body))); return call.completed;
  }
  login(password = OWNER_PASSWORD, email = OWNER_EMAIL) { return this.call("/api/auth/sign-in/email", { body: { email, password } }); }
  session() { return this.call("/api/auth/get-session", { method: "GET" }); }
  async authenticated() { expect(await this.login()).toMatchObject({ status: 200, body: { authenticated: true } }); return this; }
}
export const write = (f: BrowserFixture, key = "browser-write") => ({ operation: "create_task", input: {
  projectId: f.project.id, title: "Browser", description: "One grant-limited effect", idempotencyKey: key,
} });
