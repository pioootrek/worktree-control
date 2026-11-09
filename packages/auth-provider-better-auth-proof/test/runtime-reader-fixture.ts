import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { createControllerAuthentication } from "@/server/bootstrap/authentication";
import { listenAdminSocket } from "@/server/admin-socket";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService, loadAuthenticationProvider, ProviderRuntimeReadApplication, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { ProcessManager } from "@/server/process-manager";
import type { Worktree } from "@/shared/contracts";
import { cliFixture } from "./cli-provider-fixture";
import { BrowserClient } from "./browser-authentication-fixture";
import { ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, PROVIDER_ENTRY } from "./fixture";

export const EXISTING_OWNER = "69849424-2aba-4fdd-b4fa-a394a77a193c";
export const SECRET = "sentinel-foreign-lease-env-command-log";
let peers = 1;
export async function runtimeReaderFixture(options: { mutations?: boolean; verification?: boolean; configuration?: boolean } = {}) {
  const files = cliFixture(), lock = acquireControllerLock(files.paths.controllerLockPath), store = new SqliteStateStore(files.paths.databasePath);
  const repoA = options.verification ? join(files.root,"a") : "/code/a", repoB = options.verification ? join(files.root,"b") : "/code/b";
  if (options.verification) { mkdirSync(repoA); mkdirSync(repoB); }
  let first = true;
  const oldIdentity = new IdentityService(store, undefined, () => { if (first) { first = false; return EXISTING_OWNER; } return randomUUID(); }, undefined, undefined, store);
  const oldOwner = oldIdentity.authenticateBearer(oldIdentity.bootstrapOwnerSession().token);
  const a = store.addProject({ name: "Runtime A", repositoryPath: repoA, port: 3721, executable: "node", args: [SECRET] });
  const b = store.addProject({ name: "Runtime B", repositoryPath: repoB, port: 3722, executable: "node", args: [SECRET] });
  store.updateProjectEnvironment(a.id, { SECRET }, "fixture");
  // Same text ID in different namespaces. Neither membership nor a link grants the other.
  store.saveKnowledgeProject({ id: a.id, name: "Knowledge A", status: "active", revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "fixture");
  oldIdentity.setKnowledgeGrant({ principalId: EXISTING_OWNER, projectId: a.id, permissions: ["knowledge:read", "knowledge:write"] }, oldOwner);
  new KnowledgeService(store, oldIdentity).execute({ operation: "create_task", input: { projectId: a.id, title: "Old history", description: "Preserve", idempotencyKey: "old" } }, oldOwner);
  const agent = oldIdentity.createAgent(oldOwner);
  oldIdentity.setRuntimeDelegation({ principalId: agent.id, projectId: a.id, actions: ["projects:read", "claims:manage", "tests:run"], expectedRevision: 0 }, oldOwner);
  const agentActor = oldIdentity.authenticateBearer(oldIdentity.issueRuntimeCredential({ principalId: agent.id, label: "unchanged agent", projects: [{ projectId: a.id, actions: ["projects:read", "claims:manage", "tests:run"] }] }, oldOwner).token);
  store.acquireReservation({ projectId: a.id, worktreePath: repoA, kind: "agent", owner: `agent:mcp:${SECRET}`, reason: SECRET, ttlSeconds: 600,
    maximumLifetimeSeconds: 3600, leaseTokenHash: "a".repeat(64), idempotencyKey: "foreign-lease", binding: { principalId: agent.id, credentialId: agentActor.credentialId! } });
  const setup = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const installationToken = setup.generateToken("fixture").token; setup.setMode("token", "fixture");
  const authentication = new AuthenticationService(store); store.requireAdmission();
  let runtime: AuthenticationProviderRuntime | undefined;
  const load = vi.fn(async (input: Parameters<typeof loadAuthenticationProvider>[0]) => { runtime = await loadAuthenticationProvider(input); return runtime; });
  const composition = createControllerAuthentication({ store, dataDirectory: files.paths.dataDirectory, authentication, actor: "local-admin", loadProvider: load });
  const knowledge = new KnowledgeService(store, composition.identity);
  const hooks: { observe?(stage: string): Promise<void>; resolve?(): void; git?(): Promise<void>; beforeSpawn?(): Promise<void>; afterSpawn?(): Promise<void>; stop?(): Promise<void> } = {};
  const discovered: Worktree = { path: "/code/a", head: "a".repeat(40), shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false, statusError: SECRET };
  const observation = () => ({observedAt:new Date().toISOString(),head:"a".repeat(40),branch:"main",dirty:false,statusDigest:"empty",statusEntries:0,complete:true,errorCode:null});
  const git = { ...(options.verification ? {observe:vi.fn(async () => {await hooks.observe?.("source");return observation();})} : {}), list: vi.fn(async (path: string) => { await hooks.git?.(); return [{ ...discovered, path }]; }) } as unknown as GitWorktreeReader;
  const states = new Map<string, {phase:"stopped"|"running"|"starting"|"stopping"|"failed";worktreePath:string|null;startedAt:string|null;pid:number|null}>();
  const state = (id: string) => states.get(id) ?? {phase:"stopped" as const, worktreePath:null,startedAt:null,pid:null};
  const start = vi.fn(async (project: {id:string}, path: string, verify?: () => void) => {
    await store.admission.idle(async () => { await hooks.beforeSpawn?.(); });
    await store.admission.run(() => { verify?.(); states.set(project.id, {phase:"running",worktreePath:path,startedAt:new Date().toISOString(),pid:12345}); });
    await store.admission.idle(async () => { await hooks.afterSpawn?.(); });
  });
  const stop = vi.fn(async (id: string) => {
    await store.admission.idle(async () => { await hooks.stop?.(); });
    states.set(id, {phase:"stopped",worktreePath:null,startedAt:null,pid:null});
  });
  const processes = { snapshot: (id: string) => ({ ...state(id), logs: [SECRET], error: SECRET, failure:null }), start, stop,
    statusSummary: (id: string) => ({...state(id),failureCode:null,ownsProcess:state(id).pid!==null}) } as unknown as ProcessManager;
  const commands = { resolve: vi.fn(() => ({executable:"node",args:["finite-process-double"],tls:{mode:"off",keyPath:null,certPath:null,caPath:null}})) };
  let delay = 0;
  const marker = join(files.root,"spawned");
  const preset = {id:"node:test",name:"test",adapter:"node" as const,timeoutMs:5000};
  const testCommands = { discover: vi.fn(() => [preset]), resolve: vi.fn((path:string) => {
    hooks.resolve?.(); return {preset,executable:process.execPath,cwd:path,args:["-e",`require('fs').appendFileSync(${JSON.stringify(marker)},'spawn\\n');console.log('${SECRET}');setTimeout(()=>{},${delay})`]};
  }) };
  const manager = options.verification ? await store.admission.run(() => new TestJobManager(store,nullLogWriter)) : undefined;
  const service = new ControlService(store, git, processes, undefined, options.mutations ? commands as never : undefined, undefined, undefined,
    (options.verification || options.configuration) ? testCommands as unknown as ProjectTestCommandResolver : undefined, manager, undefined, undefined, undefined, composition.identity);

  const app = new ProviderRuntimeReadApplication(store.admission, composition.identity, service);
  const admin = await listenAdminSocket(files.paths.adminSocketPath, body => composition.execute(body));
  const entry = join(files.root, "runtime-provider.mjs"); writeFileSync(entry, `export { authenticationProvider } from ${JSON.stringify(PROVIDER_ENTRY)};`, { mode: 0o600 });
  await composition.execute({ command: "auth-provider", action: "configure", input: { module: entry, origin: ORIGIN, signingSecret: { kind: "generate" } } });
  const principal = (await composition.execute({ command: "auth-provider", action: "human-create" }) as { principal: { id: string } }).principal;
  const peer = `198.19.1.${peers++}`;
  let http: ReturnType<typeof createServer> | undefined;
  const listen = async () => {
    const adapter = await composition.prepareBrowserAuthentication({ origin: ORIGIN, knowledge, runtimeReads: service, ...(options.mutations ? {runtimeMutations:service} : {}), ...(options.verification ? {verification:service} : {}), ...(options.configuration ? {configuration:service} : {}), trustedFixturePeer: peer });
    http = createServer((request, response) => { void adapter.handle(request, response); });
    const socket = join(files.root, "runtime-reader.sock"); await new Promise<void>(resolve => http!.listen(socket, resolve));
    return { owner: new BrowserClient(socket), human: new BrowserClient(socket), adapter };
  };
  const enroll = async () => {
    await composition.execute({ command: "auth-provider", action: "enroll", principalId: EXISTING_OWNER, input: { email: OWNER_EMAIL, name: "Existing owner", password: OWNER_PASSWORD } });
    await composition.execute({ command: "auth-provider", action: "enroll", principalId: principal.id, input: { email: "runtime-human@fixture.invalid", name: "Human", password: OWNER_PASSWORD } });
  };
  const set = (principalId: string, projectId = a.id, expectedRevision = 0) => files.run(["runtime-access", "set", ...files.input({ principalId, scope: { kind: "runtime-project", id: projectId }, role: "reader", permissions: ["projects:read"], expectedRevision })]);
  const revoke = (principalId: string, expectedRevision = 1) => files.run(["runtime-access", "revoke", ...files.input({ principalId, scope: { kind: "runtime-project", id: a.id }, expectedRevision })]);
  const core = <T>(operation: () => T | Promise<T>) => store.admission.run(operation);
  const actor = async (client: BrowserClient): Promise<ProviderSessionActor> => {
    const result = await runtime!.authenticate(new Headers({ cookie: client.cookie })); if (!result) throw new Error("Missing fixture actor"); return result;
  };
  const sql = async (statement: string, parameters: unknown[] = []) => {
    const storage = store.authenticationProviderStorage(), connection = storage.createProviderConnection();
    try { await storage.borrow(async () => { connection.prepare(statement).run(parameters as never); }); } finally { connection.close(); }
  };
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    await new Promise<void>((resolve, reject) => http ? http.close(error => error ? reject(error) : resolve()) : resolve());
    await manager?.shutdown(); await admin.close(); await composition.dispose(); await store.closeAfterDrain(); lock.release();
  };
  const close = async () => { await detach(); files.remove(); };
  return { ...files, store, composition, knowledge, service, app, load, a, b, human: principal.id, oldOwner, agentActor,
    installationToken, states, hooks, git, start, stop, commands, manager, testCommands, marker, observation, setDelay:(ms:number)=>{delay=ms;}, core, enroll, listen, set, revoke, actor, sql, runtime: () => runtime!, detach, close };
}
