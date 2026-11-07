import { join } from "node:path";
import { FileProviderConfiguration, validateProviderEntry } from "../authentication-provider-configuration";
import { IdentityService, IdentityError, HumanAccountService, RuntimeMembershipService } from "../modules/identity";
import {
  ProviderAdminApplication, ProviderAdminError, AuthenticationProviderError, loadAuthenticationProvider,
  type AuthenticationProviderRuntime, type AuthenticationProviderStorage, type AuthenticationService,
  type ProviderConfiguration, type ProviderMaintenanceState, type ProviderInvalidation,
} from "../modules/authentication";
import type { KnowledgeService } from "../modules/knowledge";
import { ProviderConfigurationApplication, type ProviderConfigurationApplicationPort, ProviderKnowledgeApplication, ProviderRuntimeReadApplication, ProviderRuntimeMutateApplication, ProviderVerificationApplication, type ProviderVerificationPort, type ProviderRuntimeReadPort, type ProviderRuntimeMutatePort } from "../modules/authentication";
import { AuthenticationHttp } from "../transports/authentication-http";
import type { ProviderSessionAuthority } from "../modules/identity";
import type { SqliteStateStore } from "../sqlite-store";

/** Engineering capacity bounds for this controller composition, independent of proof fixtures.
 * They bound work/storage; they neither select account mode nor prescribe account protection.
 */
export const CONTROLLER_AUTHENTICATION_POLICY = Object.freeze({
  unreleasedSessions: 64, sessionRows: 4096, sessionReconcileBatch: 32,
  maxInFlight: 16,
  limits: Object.freeze({ passwordBodyBytes: 8192, webAuthnBodyBytes: 65_536,
    knowledgeBodyBytes: 131_072, cookieBytes: 8192, bodyTimeoutMs: 10_000,
    json: Object.freeze({ maxDepth: 8, maxFields: 128 }),
    knowledgeJson: Object.freeze({ maxDepth: 16, maxFields: 2048 }), reservedCompletionSlots: 4 }),
});

export interface ControllerAuthenticationOptions {
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

interface BrowserAuthenticationInput {
  origin: string; knowledge: KnowledgeService; runtimeReads?: ProviderRuntimeReadPort; runtimeMutations?: ProviderRuntimeMutatePort; verification?: ProviderVerificationPort; configuration?: ProviderConfigurationApplicationPort;
  /** Temporary Unix fixtures only. A real listener derives its peer from the socket. */
  trustedFixturePeer?: string;
}

/** One provider lifetime and current-session authority on the existing controller store. */
export function createControllerAuthentication(d: ControllerAuthenticationOptions) {
  let stopping = false, state: ProviderMaintenanceState = "not_loaded";
  let pinned: ProviderConfiguration | undefined, loaded: Promise<AuthenticationProviderRuntime> | undefined;
  let runtime: AuthenticationProviderRuntime | undefined, failure: unknown, disposal: Promise<void> | undefined;
  let releaseLifetime: (() => void) | undefined;
  let browser: { adapter: AuthenticationHttp; binding: Readonly<BrowserAuthenticationInput> } | undefined;
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
  // Reuse the ONE existing connection gate. New work checks the current config in its actual borrow.
  // Reserved work is runtime-owned cleanup of exact sessions minted here, never new authentication.
  // It must still be able to settle after maintenance/configuration changes fence new work.
  const guardedStorage: AuthenticationProviderStorage = { ...storage,
    borrow: (operation, options) => storage.borrow(() => {
      if (!options?.reserved) storage.runControllerOperation(guard);
      return operation();
    }, options),
  };
  const authority: ProviderSessionAuthority = {
    captureRuntimeSession(actor, now) {
      try { guard(); return state === "ready" ? runtime?.captureRuntimeSession(actor, now) ?? null : null; } catch { return null; }
    },
    validateRetainedRuntimeSession(reference, now) {
      try { guard(); return state === "ready" && runtime?.validateRetainedRuntimeSession(reference, now) === true; } catch { return false; }
    },
    resolveRuntimeSession(actor, now) {
      try { guard(); return state === "ready" ? runtime?.resolveRuntimeSession(actor, now) ?? null : null; }
      catch { return null; }
    },
    isCurrentProviderSession(actor, now) {
      try {
        guard();
        return state === "ready" && runtime?.isCurrentProviderSession(actor, now) === true;
      } catch { return false; }
    },
  };
  const identity = new IdentityService(d.store, undefined, undefined, undefined, d.authentication, d.store, authority, d.store.runtimeMemberships());
  const track = <T>(pending: Promise<T>): Promise<T> => {
    accepted.add(pending);
    const forget = () => { accepted.delete(pending); };
    pending.then(forget, forget);
    return pending;
  };
  const providerRuntime = {
    factorResetSupport: (): "not_loaded" | "supported" | "unsupported" => runtime ? (runtime.supportsLocalFactorReset ? "supported" : "unsupported") : "not_loaded",
    state: (): ProviderMaintenanceState => state === "ready" && !storage.available() ? "failed" : state,
    configurationRestartRequired: changed,
    get(current: ProviderConfiguration) {
      if (maintenance()) return Promise.reject(new ProviderAdminError("maintenance"));
      if (changed(current)) return Promise.reject(new ProviderAdminError("provider_configuration_restart_required"));
      if (!storage.available()) { state = "failed"; return Promise.reject(new ProviderAdminError("database_unavailable")); }
      if (!loaded) {
        pinned = Object.freeze({ ...current }); state = "loading";
        // Promise publication precedes import/create, including synchronous loader failures.
        retainLifetime();
        loaded = Promise.resolve().then(async () => {
          // The store checks the external checkpoint before boot recovery. A restored
          // store requires its protected quarantine receipt before this lifetime exists.
          await d.store.recoverIssuedSessions(CONTROLLER_AUTHENTICATION_POLICY);
          await d.store.admission.run(guard);
          validateProviderEntry(current.entry);
          return (d.loadProvider ?? loadAuthenticationProvider)({ entry: current.entry, providerId: "better-auth", storage: guardedStorage,
            unreleasedSessions: CONTROLLER_AUTHENTICATION_POLICY.unreleasedSessions,
            sessionRows: CONTROLLER_AUTHENTICATION_POLICY.sessionRows,
            sessionReconcileBatch: CONTROLLER_AUTHENTICATION_POLICY.sessionReconcileBatch,
            options: { baseURL: current.baseURL, secret: current.secret, clientIpHeader: "x-worktree-control-client-ip" },
            // Maintenance fences transaction entry. Once writing, shutdown drains
            // accepted recovery; changed configuration still fences its commit.
            assertAvailable: phase => {
              if (phase !== "commit") return guard();
              if (changed(configuration.read())) throw new AuthenticationProviderError("provider_configuration_restart_required", "Provider configuration requires a new owner boot.");
            }, onInvalidation: d.onInvalidation });
        }).then(value => { runtime = value; if (!stopping) state = "ready"; return value; }, error => {
          failure = error;
          if (!stopping) state = error instanceof AuthenticationProviderError && error.code === "disposal_unconfirmed" ? "disposal_unconfirmed" : "failed";
          throw error;
        });
      }
      return loaded;
    },
  };

  const application = new ProviderAdminApplication({
    humans: new HumanAccountService(d.store.humanAccounts(), d.actor),
    runtimeMemberships: new RuntimeMembershipService(d.store.runtimeMemberships(), d.actor),
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
    runtime: providerRuntime,
  });
  return {
    identity,
    /** Internal server seam for converted browser workflows. Production does not mount it yet.
     * Uses this exact runtime and identity; an HTTPS deployment origin must match pinned config.
     * The caller owns listener drain before dispose(), as in createControllerShutdown.
     */
    prepareBrowserAuthentication(input: BrowserAuthenticationInput): Promise<AuthenticationHttp> {
      const binding = Object.freeze({ ...input });
      if (maintenance()) return Promise.reject(new ProviderAdminError("maintenance"));
      retainLifetime();
      return track(Promise.resolve().then(async () => {
        const current = await d.store.admission.run(() => {
          guard();
          const value = configuration.read();
          if (!value) throw new ProviderAdminError("configuration_missing");
          if (new URL(value.baseURL).origin !== binding.origin) throw new ProviderAdminError("configuration_invalid");
          return value;
        });
        const value = await providerRuntime.get(current);
        await d.store.admission.run(guard);
        if (value.disposed || !value.issuanceBounded) throw new AuthenticationProviderError("provider_unavailable", "Authentication provider is unavailable.");
        if (browser) {
          if (browser.binding.origin !== binding.origin || browser.binding.knowledge !== binding.knowledge || browser.binding.runtimeReads !== binding.runtimeReads || browser.binding.runtimeMutations !== binding.runtimeMutations || browser.binding.verification !== binding.verification || browser.binding.configuration !== binding.configuration
            || browser.binding.trustedFixturePeer !== binding.trustedFixturePeer) throw new ProviderAdminError("configuration_invalid");
          return browser.adapter;
        }
        const adapter = new AuthenticationHttp({ origin: binding.origin, runtime: value, admission: d.store.admission,
          knowledge: new ProviderKnowledgeApplication(d.store.admission, identity, binding.knowledge),
          runtimeReads: binding.runtimeReads && new ProviderRuntimeReadApplication(d.store.admission, identity, binding.runtimeReads),
          configuration: binding.configuration && new ProviderConfigurationApplication(binding.configuration),
          verification: binding.verification && new ProviderVerificationApplication(binding.verification),
          runtimeMutations: binding.runtimeMutations && new ProviderRuntimeMutateApplication(binding.runtimeMutations),
          maintenance, assertAvailable: guard,
          trustedFixturePeer: binding.trustedFixturePeer,
          maxInFlight: CONTROLLER_AUTHENTICATION_POLICY.maxInFlight, limits: CONTROLLER_AUTHENTICATION_POLICY.limits,
          status: () => ({ mode: d.authentication.mode(), loginAvailable: !value.disposed }),
        });
        browser = { adapter, binding };
        return adapter;
      }));
    },
    execute(body: unknown): Promise<unknown> {
      if (maintenance()) return Promise.reject(new ProviderAdminError("maintenance"));
      retainLifetime();
      return track(application.execute(body));
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      retainLifetime();
      stopping = true; state = "disposing";
      disposal = Promise.resolve().then(async () => {
        await Promise.allSettled([...accepted]);
        await loaded?.catch(() => undefined);
        if (failure instanceof AuthenticationProviderError && failure.code === "disposal_unconfirmed") throw failure;
        if (runtime) await runtime.dispose({ timeoutMs: d.drainTimeoutMs });
        else if (!await storage.drain(d.drainTimeoutMs ?? 10_000)) throw new ProviderAdminError("disposal_unconfirmed", undefined, false);
        releaseLifetime?.(); releaseLifetime = undefined;
      }).catch(error => { failure = error; state = "disposal_unconfirmed"; throw new ProviderAdminError("disposal_unconfirmed", undefined, false); });
      return disposal;
    },
  };
}
