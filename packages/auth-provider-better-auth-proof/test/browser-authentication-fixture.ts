import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { join } from "node:path";
import { expect } from "vitest";
import type { ControlService } from "@/server/control-service";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { AuthenticationService, ProviderKnowledgeApplication } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { AuthenticationHttp } from "@/server/transports/authentication-http";
import type { ProofFaultInjection } from "../src/index";
import { ORIGIN, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { closeStrictProof, strictProof } from "./strict-fixture";

export async function browserFixture(faults: ProofFaultInjection = {}, options = {}, maxInFlight = 8) {
  const f = await strictProof(faults, options);
  await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
  // Open is the frozen product boot mode; optional proof composition grants cookies ONLY converted Knowledge access.
  // No production selector, env switch or alternate product mode exists.
  await f.run(() => new AuthenticationService(f.store).setMode("open", "local-cli"));
  const authentication = await f.run(() => new AuthenticationService(f.store));
  const identity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, f.runtime);
  const knowledge = new KnowledgeService(f.store, identity);
  const app = new ProviderKnowledgeApplication(f.store.admission, identity, knowledge);
  let maintenance = false;
  const adapter = new AuthenticationHttp({ origin: ORIGIN, runtime: f.runtime, admission: f.store.admission,
    knowledge: app, status: () => ({ mode: authentication.mode(), loginAvailable: true }), maxInFlight,
    // A Unix peer has no IP. Explicitly trusted ONLY for temporary isolated fixture transport.
    trustedFixturePeer: "198.51.100.12", maintenance: () => maintenance });
  const service = { dashboard: () => { throw new Error("unconverted provider route reached installation authority"); } } as unknown as ControlService;
  const http = createControllerServer({ service, identity, authentication, admission: f.store.admission, browserAuthentication: adapter,
    directoryBrowser: {} as DirectoryBrowser, events: new EventStream(f.store.admission),
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
    webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture" });
  const socketPath = join(f.root, "browser.sock");
  await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(socketPath, resolve); });
  const project = await f.run(() => f.identity.createKnowledgeProject({ name: "Browser grant" }, f.ownerActor));
  const grant = () => f.run(() => f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id,
    permissions: ["knowledge:read", "knowledge:write"] }, f.ownerActor));
  const client = () => new BrowserClient(socketPath);
  return { ...f, authentication, identity, app, adapter, http, project, grant, client, setMaintenance: () => { maintenance = true; },
    close: async () => { await http.close(); await closeStrictProof(f); } };
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
export interface HttpResult { status: number; body: Record<string, unknown>; headers: import("node:http").IncomingHttpHeaders }
export class BrowserClient {
  cookie = "";
  constructor(readonly socketPath: string) {}
  start(path: string, init: { method?: string; body?: unknown; raw?: string; headers?: OutgoingHttpHeaders; cookie?: string; omitOrigin?: boolean } = {}) {
    let resolve!: (value: HttpResult) => void, reject!: (error: unknown) => void;
    const completed = new Promise<HttpResult>((yes, no) => { resolve = yes; reject = no; });
    const headers: OutgoingHttpHeaders = { host: "controller.test", "content-type": "application/json", connection: "close", ...(!init.omitOrigin ? { origin: ORIGIN } : {}),
      ...((init.cookie ?? this.cookie) ? { cookie: init.cookie ?? this.cookie } : {}), ...init.headers };
    const call = httpRequest({ socketPath: this.socketPath, path, method: init.method ?? "POST", headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => {
        const cookies = response.headers["set-cookie"] ?? [];
        for (const line of cookies) if (line.startsWith("__Secure-wtc.session_token=")) this.cookie = /max-age=0/i.test(line) ? "" : line.split(";")[0];
        resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: response.headers });
      });
    });
    call.on("error", reject); call.flushHeaders();
    return { completed, send: (raw: string) => call.end(raw), abort: () => call.destroy() };
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
