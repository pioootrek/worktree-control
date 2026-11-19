import type { DatabaseAdmissionOptions } from "../database-admission";
import type { SqliteStateStore } from "../sqlite-store";
import type { LogWriter } from "../log-writer";
import type { AuthenticationProviderRuntime, VerifiedProviderSession } from "../modules/authentication";
import {
  AgentTokenVerifier, CompositeCredentialVerifier, createListenerBoundary, InstallationVerifier,
  OperationError, OperationRegistry, OperationRunner, ProviderSessionVerifier, sessionDescribe,
  sqliteGrants, SqliteResourceResolver, admissionFailureOf, mintOfflineContext, publicError, resolveAcceptance,
  type AuthenticationContext, type ListenerBoundary, type OperationRuntime, type PresentedCredentials,
} from "../modules/operations";
import { authenticationModes, type AuthenticationMode, type ListenerKind, type PublicOperationError } from "../../shared/contracts/operations";
import { CONTROLLER_OPERATION_SESSION_POLICY, type createControllerOperationEligibility } from "./authentication-provider-lifetime";

type ServedListener = Exclude<ListenerKind, "offline">;
type MintResult = { readonly ok: true; readonly context: AuthenticationContext } | { readonly ok: false; readonly error: PublicOperationError };

export interface OperationsRuntimeOptions {
  store: SqliteStateStore;
  /** The immutable start snapshot. Never the stored next-start selection. */
  activeMode: string;
  now(): number;
  logs: Pick<LogWriter, "controller">;
  listeners: Readonly<Partial<Record<ServedListener, () => boolean>>>;
  eligibility: Pick<ReturnType<typeof createControllerOperationEligibility>, "controllerEligible" | "providerSessionEligible">;
  /** Null when this boot has no provider with session authority (including
   * offline CLI). Never use null for a temporarily ineligible existing provider.
   * No loading here.
   */
  provider: Pick<AuthenticationProviderRuntime, "isSessionAuthorityEligible"> | null;
}

function holds(call: () => unknown): boolean {
  try {
    const value = call();
    if (value === true) return true;
    // Do not leave a rejected promise unhandled when a synchronous port errs.
    Promise.resolve(value).catch(() => undefined);
  } catch { /* closed */ }
  return false;
}
const refused = (reason: string): MintResult => Object.freeze({ ok: false, error: publicError(new OperationError("unauthenticated", reason)) });

function mintFailure(error: unknown, admissionOptions: DatabaseAdmissionOptions): MintResult {
  // Match the runner: an aborted admission is cancellation, not contention.
  const failure = admissionOptions.signal?.aborted && admissionFailureOf(error)
    ? new OperationError("unavailable", "request_cancelled", { retry: "retry" }) : error;
  return Object.freeze({ ok: false, error: publicError(failure) });
}

/** Built and tested, but deliberately not called by any production path yet. */
export function buildOperationsRuntime(options: OperationsRuntimeOptions) {
  const { store, activeMode, now, logs, provider, eligibility } = options;
  // In particular, legacy boot must not construct a boundary or verifier.
  if (!(authenticationModes as readonly string[]).includes(activeMode)) {
    return Object.freeze({ supported: false as const, eligible: () => false, providerSessionEligible: null,
      mint: async (): Promise<MintResult> => refused("unknown_mode"),
      mintOffline: async (): Promise<MintResult> => refused("unknown_mode") });
  }
  const mode = activeMode as AuthenticationMode;
  const controllerEligible = () => holds(eligibility.controllerEligible);
  const providerSessionEligible = provider === null ? null
    : () => holds(eligibility.providerSessionEligible) && holds(() => provider.isSessionAuthorityEligible());
  const runtime: OperationRuntime = Object.freeze({
    admission: store.admission,
    resolver: new SqliteResourceResolver(store.projectDirectoryReader()),
    // sqliteGrants returns a FACTORY, not a snapshot. The runner calls it in each phase.
    grants: sqliteGrants(store.accountGrantsReader()),
    now,
    observer: Object.freeze({ streamDisposalFailed(event: { operationId: string; kind: "rejected" | "timed_out" }) {
      logs.controller("operations.stream_disposal_failed", { operationId: event.operationId, kind: event.kind });
    } }),
  });
  const registry = new OperationRegistry();
  registry.register(sessionDescribe);
  const registryView = Object.freeze({
    get: registry.get.bind(registry),
    ids: registry.ids.bind(registry),
    availableOn: registry.availableOn.bind(registry),
    idsOn: registry.idsOn.bind(registry),
  });
  const runner = new OperationRunner(runtime);
  const sessions = providerSessionEligible === null ? null : new ProviderSessionVerifier({
    providerId: "better-auth", reader: store.authenticationProviderStorage(), now, eligible: providerSessionEligible,
    stagedCapacity: CONTROLLER_OPERATION_SESSION_POLICY.stagedCapacity,
    stagedTtlMs: CONTROLLER_OPERATION_SESSION_POLICY.stagedTtlMs,
  });
  const verifier = new CompositeCredentialVerifier({
    installation: new InstallationVerifier({ mode, reader: store }),
    agent: new AgentTokenVerifier({ reader: store.machineCredentialReader(), now }),
    providerSession: sessions,
  });
  const boundaries: Partial<Record<ServedListener, ListenerBoundary>> = {};
  for (const listener of ["api", "mcp", "worker", "unix"] as const) {
    const open = options.listeners[listener];
    if (open) boundaries[listener] = createListenerBoundary({ mode, listener, verifier, open: () => controllerEligible() && holds(open) });
  }
  Object.freeze(boundaries);
  return Object.freeze({ supported: true as const, runtime, runner, registry: registryView, boundaries,
    /** Controller maintenance/shutdown gate for every request's read-release.
     * Human contexts also enforce provider eligibility through revalidation.
     */
    eligible: controllerEligible,
    /** Provider-only gate for cookie transports before provider work; null
     * when this boot has no provider. Also checked at stage, mint and revalidation.
     */
    providerSessionEligible,
    /** Offline callers must mint through this composition, never call
     * mintOfflineContext themselves: controller eligibility and the synchronous owner lock
     * must hold at mint and every revalidation, inside core admission.
     */
    async mintOffline(lockHeld: () => boolean, admissionOptions: DatabaseAdmissionOptions): Promise<MintResult> {
      try {
        return await store.admission.run((): MintResult => {
          const context = mintOfflineContext({ mode, lockHeld: () => controllerEligible() && holds(lockHeld) });
          context.revalidate();
          return Object.freeze({ ok: true, context });
        }, admissionOptions);
      } catch (error) {
        return mintFailure(error, admissionOptions);
      }
    },
    /** Provider resolution was awaited outside admission. Preserve raw credential
     * multiplicity in presented, including a cookie whose resolution failed.
     * resolvedSession is trusted server evidence, never request JSON.
     */
    async mint(listener: ServedListener, presented: PresentedCredentials, resolvedSession: VerifiedProviderSession | null,
      admissionOptions: DatabaseAdmissionOptions): Promise<MintResult> {
      try {
        return await store.admission.run((): MintResult => {
          if (!controllerEligible()) return refused("listener_closed");
          const boundary = boundaries[listener];
          if (!boundary) return refused("listener_closed");
          const acceptance = resolveAcceptance(mode, listener, presented);
          if (!acceptance.accepted) return refused(acceptance.reason);
          if (acceptance.path === "provider_session" && !providerSessionEligible?.()) return refused("invalid_credential");
          const at: unknown = now();
          if (typeof at !== "number" || !Number.isFinite(at)) {
            Promise.resolve(at).catch(() => undefined);
            return refused("invalid_credential");
          }
          let credentials = presented;
          if (presented.providerSession && sessions && resolvedSession) {
            const handle = sessions.stage(resolvedSession);
            if (!handle) return refused("invalid_credential");
            credentials = { ...presented, providerSession: { secret: handle } };
          } else if (presented.providerSession) {
            // A wire string is never accepted as a staged provider handle.
            credentials = { ...presented, providerSession: { secret: "" } };
          }
          const context = boundary.mint(credentials);
          // Ordinary boundaries check open on revalidation, not on bearer mint.
          context.revalidate();
          return Object.freeze({ ok: true, context });
        }, admissionOptions);
      } catch (error) {
        return mintFailure(error, admissionOptions);
      }
    },
  });
}
