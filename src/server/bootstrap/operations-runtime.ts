import type { DatabaseAdmissionOptions } from "../database-admission";
import type { SqliteStateStore } from "../sqlite-store";
import type { LogWriter } from "../log-writer";
import type { VerifiedProviderSession } from "../modules/authentication";
import {
  AgentTokenVerifier, CompositeCredentialVerifier, createListenerBoundary, InstallationVerifier,
  OperationError, OperationRegistry, OperationRunner, ProviderSessionVerifier, sessionDescribe,
  sqliteGrants, SqliteResourceResolver, admissionFailureOf, mintOfflineContext, publicError, resolveAcceptance,
  type AuthenticationContext, type ListenerBoundary, type OperationRuntime, type PresentedCredentials,
} from "../modules/operations";
import { authenticationModes, type AuthenticationMode, type ListenerKind, type PublicOperationError } from "../../shared/contracts/operations";
import { CONTROLLER_OPERATION_SESSION_POLICY, type ControllerOperationSessionAuthority, type createControllerOperationEligibility } from "./authentication-provider-lifetime";
import type { AuthenticationRequestBudget } from "./authentication-request-budget";

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
  /** Administration-owned stable accessor; offline callers may supply null. */
  provider: ControllerOperationSessionAuthority | null;
  requestBudget: AuthenticationRequestBudget;
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

/** One store owner, shared by mounted transports. */
export function buildOperationsRuntime(options: OperationsRuntimeOptions) {
  const { store, activeMode, now, logs, provider, eligibility } = options;
  const supported = (authenticationModes as readonly string[]).includes(activeMode);
  const providerSessionEligible = () => supported && provider !== null
    && holds(eligibility.providerSessionEligible) && holds(() => provider.isSessionAuthorityEligible());
  const resolveSession: ControllerOperationSessionAuthority["resolveRequest"] = (headers, requestOptions) => {
    if (!providerSessionEligible()) return { result: Promise.resolve(null), settled: Promise.resolve() };
    return provider!.resolveRequest(headers, requestOptions);
  };
  // In particular, legacy boot must not construct a boundary or verifier.
  if (!supported) {
    return Object.freeze({ supported: false as const, eligible: () => false, providerSessionEligible, resolveSession, requestBudget: options.requestBudget,
      mint: async (): Promise<MintResult> => refused("unknown_mode"),
      mintOffline: async (): Promise<MintResult> => refused("unknown_mode") });
  }
  const mode = activeMode as AuthenticationMode;
  const controllerEligible = () => holds(eligibility.controllerEligible);
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
  const sessions = provider === null ? null : new ProviderSessionVerifier({
    providerId: provider.providerId, reader: provider.reader, now, eligible: providerSessionEligible,
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
    /** Always callable, including before the provider becomes ready. */
    providerSessionEligible,
    resolveSession,
    requestBudget: options.requestBudget,
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
          if (acceptance.path === "provider_session" && !providerSessionEligible()) return refused("invalid_credential");
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
