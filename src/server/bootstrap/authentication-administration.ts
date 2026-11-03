import { join } from "node:path";
import { FileProviderConfiguration, validateProviderEntry } from "../authentication-provider-configuration";
import { IdentityService, IdentityError, HumanAccountService } from "../modules/identity";
import {
  ProviderAdminApplication, ProviderAdminError, AuthenticationProviderError, loadAuthenticationProvider,
  type AuthenticationProviderRuntime, type AuthenticationProviderStorage, type AuthenticationService,
  type ProviderConfiguration, type ProviderMaintenanceState, type ProviderInvalidation,
} from "../modules/authentication";
import type { SqliteStateStore } from "../sqlite-store";

export interface AuthenticationAdministrationOptions {
  store: SqliteStateStore; dataDirectory: string; authentication: AuthenticationService;
  actor: "local-cli" | "local-admin"; maintenance?(): boolean;
  /** Trusted composition/test seams. These never cross the protected command parser. */
  loadProvider?: typeof loadAuthenticationProvider;
  onInvalidation?: (event: ProviderInvalidation) => void;
  configurationEvent?: () => void;
  drainTimeoutMs?: number;
  /** Finite fixtures may own/release their handle after observing terminal failure. */
  holdLifetime?: () => () => void;
}

/** One lazy maintenance lifetime owned by the controller or stopped CLI, never a browser mount. */
export function createAuthenticationAdministration(d: AuthenticationAdministrationOptions) {
  let stopping = false, state: ProviderMaintenanceState = "not_loaded";
  let pinned: ProviderConfiguration | undefined, loaded: Promise<AuthenticationProviderRuntime> | undefined;
  let runtime: AuthenticationProviderRuntime | undefined, failure: unknown, disposal: Promise<void> | undefined;
  let releaseLifetime: (() => void) | undefined;
  const retainLifetime = () => {
    releaseLifetime ??= d.holdLifetime?.() ?? (() => {
      const lifetime = setInterval(() => { void runtime; void failure; }, 60_000);
      return () => clearInterval(lifetime);
    })();
  };
  const accepted = new Set<Promise<unknown>>(), storage = d.store.authenticationProviderStorage();
  const configuration = new FileProviderConfiguration(join(d.dataDirectory, "authentication-provider.json"),
    () => d.store.listProjects().map(project => project.repositoryPath), d.configurationEvent);
  const changed = (current: ProviderConfiguration | null) => pinned !== undefined &&
    (!current || current.entry !== pinned.entry || current.baseURL !== pinned.baseURL || current.secret !== pinned.secret);
  const maintenance = () => stopping || Boolean(d.maintenance?.());
  const guard = () => {
    if (maintenance()) throw new AuthenticationProviderError("maintenance", "Controller provider administration is in maintenance.");
    if (changed(configuration.read())) throw new AuthenticationProviderError("provider_configuration_restart_required", "Provider configuration requires a new owner boot.");
  };
  // Reuse the ONE existing connection gate. Guard runs when the queued borrow actually executes.
  const guardedStorage: AuthenticationProviderStorage = { ...storage,
    borrow: (operation, options) => storage.borrow(() => {
      storage.runControllerOperation(guard);
      return operation();
    }, options),
  };
  const identity = new IdentityService(d.store);
  const application = new ProviderAdminApplication({
    humans: new HumanAccountService(d.store.humanAccounts(), d.actor),
    admission: d.store.admission, authentication: d.authentication, configuration, maintenance, actor: d.actor,
    identity: {
      ownerStatus: () => identity.ownerPrincipalStatus(),
      createOwner: actor => {
        try { return identity.createFirstOwnerPrincipal(actor); }
        catch (error) {
          if (error instanceof IdentityError && error.code === "owner_already_initialized") throw new ProviderAdminError("owner_already_initialized");
          throw error;
        }
      },
      principal: id => {
        const principal = d.store.getPrincipal(id);
        if (!principal) return null;
        const subjects = storage.subjects("better-auth");
        return { ...principal, enrollment: subjects.findByPrincipal(id) ? "active" : subjects.hasSubjectHistory(id) ? "revoked" : "absent" };
      },
      hasProviderData: () => d.store.hasAuthenticationProviderData(),
    },
    runtime: {
      state: () => state === "ready" && !storage.available() ? "failed" : state,
      configurationRestartRequired: changed,
      get(current) {
        if (maintenance()) return Promise.reject(new ProviderAdminError("maintenance"));
        if (changed(current)) return Promise.reject(new ProviderAdminError("provider_configuration_restart_required"));
        if (!storage.available()) { state = "failed"; return Promise.reject(new ProviderAdminError("database_unavailable")); }
        if (!loaded) {
          pinned = Object.freeze({ ...current }); state = "loading";
          // Promise publication precedes import/create, including synchronous loader failures.
          loaded = Promise.resolve().then(() => {
            validateProviderEntry(current.entry);
            return (d.loadProvider ?? loadAuthenticationProvider)({ entry: current.entry, providerId: "better-auth", storage: guardedStorage,
              options: { baseURL: current.baseURL, secret: current.secret, clientIpHeader: "x-worktree-control-client-ip" },
              onInvalidation: d.onInvalidation });
          }).then(value => { runtime = value; if (!stopping) state = "ready"; return value; }, error => {
            failure = error;
            if (!stopping) state = error instanceof AuthenticationProviderError && error.code === "disposal_unconfirmed" ? "disposal_unconfirmed" : "failed";
            throw error;
          });
        }
        return loaded;
      },
    },
  });
  return {
    execute(body: unknown): Promise<unknown> {
      if (maintenance()) return Promise.reject(new ProviderAdminError("maintenance"));
      retainLifetime();
      const pending = application.execute(body);
      accepted.add(pending);
      const forget = () => { accepted.delete(pending); };
      pending.then(forget, forget);
      return pending;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      retainLifetime();
      stopping = true; state = "disposing";
      disposal = Promise.resolve().then(async () => {
        await Promise.allSettled([...accepted]);
        await loaded?.catch(() => undefined);
        if (failure instanceof AuthenticationProviderError && failure.code === "disposal_unconfirmed") throw failure;
        await runtime?.dispose({ timeoutMs: d.drainTimeoutMs });
        if (!await storage.drain(d.drainTimeoutMs ?? 10_000)) throw new ProviderAdminError("disposal_unconfirmed", undefined, false);
        releaseLifetime?.(); releaseLifetime = undefined;
      }).catch(error => { failure = error; state = "disposal_unconfirmed"; throw new ProviderAdminError("disposal_unconfirmed", undefined, false); });
      return disposal;
    },
  };
}

/** A pending promise/exitCode alone cannot retain Node ownership after uncertain cleanup. */
const retainedOwners = new Set<{ resource: unknown; lifetime: ReturnType<typeof setInterval> }>();
export function retainAuthenticationOwnership(resource: unknown): void {
  const retained = { resource, lifetime: setInterval(() => { void retained.resource; }, 60_000) };
  retainedOwners.add(retained); // Referenced timer, resources and actual owner locks survive normal event-loop drain.
  process.exitCode = 1;
}
