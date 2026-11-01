import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand, type AuthCommandDependencies } from "@/cli/auth-management";
import { createAuthenticationAdministration } from "@/server/bootstrap/authentication-administration";
import { acquireControllerLock } from "@/server/controller-lock";
import { listenAdminSocket } from "@/server/admin-socket";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { resolveAppPaths } from "@/server/paths";
import type { ProofFaultInjection } from "../src/index";
import { ORIGIN, PROVIDER_ENTRY } from "./fixture";

export function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), "provider-cli-")), paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  let sequence = 0;
  const input = (body: unknown) => {
    const path = join(root, `input-${++sequence}.json`);
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 }); return ["--input-file", path];
  };
  const run = async (args: string[], dependencies: AuthCommandDependencies = {}) => {
    const lines: string[] = [];
    await runAuthCommand(["provider", ...args], paths, { ...dependencies, write: line => lines.push(line) });
    if (lines.length !== 1) throw new Error("Expected one sanitized CLI result.");
    return JSON.parse(lines[0]) as Record<string, unknown>;
  };
  const configure = (origin = ORIGIN, kind: "generate" | "preserve" = "generate", source = PROVIDER_ENTRY) => {
    // The checkout deliberately permits group writes. Trust a private entry; transitive code
    // remains the actual pinned fixture module (the loader is not a dependency-tree sandbox).
    const module = join(root, `provider-${++sequence}.mjs`);
    writeFileSync(module, `export { authenticationProvider } from ${JSON.stringify(source)};`, { mode: 0o600 });
    return run(["configure", ...input({ module, origin, signingSecret: { kind } })]);
  };
  const create = async () => ((await run(["owner", "create"])).principal as { id: string }).id;
  return { root, paths, input, run, configure, create, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export async function onlineCliFixture(options: { faults?: ProofFaultInjection; mode?: "open" | "token"; onInvalidation?: () => void;
  beforeLoad?: () => Promise<void>; afterLoad?: () => Promise<void>; drainTimeoutMs?: number; storeOptions?: ConstructorParameters<typeof SqliteStateStore>[2] } = {}) {
  const f = cliFixture(); await f.configure(); const principalId = await f.create();
  const lock = acquireControllerLock(f.paths.controllerLockPath), store = new SqliteStateStore(f.paths.databasePath, undefined, options.storeOptions);
  const setup = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const token = setup.generateToken("fixture").token; setup.setMode(options.mode ?? "open", "fixture");
  const authentication = new AuthenticationService(store);
  store.requireAdmission();
  let maintenance = false, runtime: AuthenticationProviderRuntime | undefined, loads = 0;
  const lifetimes: Array<ReturnType<typeof setInterval>> = [];
  const administration = createAuthenticationAdministration({ store, dataDirectory: f.paths.dataDirectory, authentication,
    actor: "local-admin", maintenance: () => maintenance, onInvalidation: options.onInvalidation,
    drainTimeoutMs: options.drainTimeoutMs,
    holdLifetime: () => { const timer = setInterval(() => {}, 60_000); lifetimes.push(timer); return () => clearInterval(timer); },
    loadProvider: async input => {
      loads++; await options.beforeLoad?.();
      runtime = await loadAuthenticationProvider({ ...input, options: { ...input.options, faultInjection: options.faults } as typeof input.options });
      await options.afterLoad?.(); return runtime;
    } });
  const admin = await listenAdminSocket(f.paths.adminSocketPath, body => administration.execute(body));
  const run = <T>(operation: () => T) => store.admission.run(operation);
  const close = async () => { maintenance = true; await admin.close(); await administration.dispose(); await store.closeAfterDrain(); lock.release(); f.remove(); };
  const remove = () => { for (const timer of lifetimes) clearInterval(timer); f.remove(); };
  return { ...f, remove, principalId, store, authentication, administration, admin, lock, token, runCore: run,
    runtime: () => { if (!runtime) throw new Error("Provider has not loaded."); return runtime; },
    loads: () => loads, maintenance: () => { maintenance = true; }, close };
}
