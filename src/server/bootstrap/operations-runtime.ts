import type { DatabaseAdmissionOptions } from "../database-admission";
import type { SqliteStateStore } from "../sqlite-store";
import type { LogWriter } from "../log-writer";
import type { AuthenticationProviderRuntime, VerifiedProviderSession } from "../modules/authentication";
import {
  AgentTokenVerifier, CompositeCredentialVerifier, createListenerBoundary, InstallationVerifier,
  OperationError, OperationRegistry, OperationRunner, ProviderSessionVerifier, sessionDescribe,
  sqliteGrants, SqliteResourceResolver, publicError, resolveAcceptance,
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
  /** Null when no provider with session authority exists. No loading here. */
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

/** Built and tested, but deliberately not called by any production path yet. */
export function buildOperationsRuntime(options: OperationsRuntimeOptions) {
  const { store, activeMode, now, logs, provider, eligibility } = options;
  // In particular, legacy boot must not construct a boundary or verifier.
  if (!(authenticationModes as readonly string[]).includes(activeMode)) {
    return Object.freeze({ supported: false as const, eligible: () => false,
      mint: async (): Promise<MintResult> => refused("unknown_mode") });
  }
  const mode = activeMode as AuthenticationMode;
  const eligible = mode === "better-auth"
    ? () => holds(eligibility.providerSessionEligible) && provider !== null && holds(() => provider.isSessionAuthorityEligible())
    : () => holds(eligibility.controllerEligible);
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
  const runner = new OperationRunner(runtime);
  const sessions = provider === null ? null : new ProviderSessionVerifier({
    providerId: "better-auth", reader: store.authenticationProviderStorage(), now, eligible,
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
    if (open) boundaries[listener] = createListenerBoundary({ mode, listener, verifier, open: () => eligible() && holds(open) });
  }
  Object.freeze(boundaries);
  return Object.freeze({ supported: true as const, runtime, runner, registry, boundaries, eligible,
    /** Provider resolution was awaited outside admission. Preserve raw credential
     * multiplicity in presented, including a cookie whose resolution failed.
     * resolvedSession is trusted server evidence, never request JSON.
     */
    async mint(listener: ServedListener, presented: PresentedCredentials, resolvedSession: VerifiedProviderSession | null,
      admissionOptions: DatabaseAdmissionOptions): Promise<MintResult> {
      try {
        return await store.admission.run((): MintResult => {
          if (!eligible()) return refused("listener_closed");
          const boundary = boundaries[listener];
          if (!boundary) return refused("listener_closed");
          const acceptance = resolveAcceptance(mode, listener, presented);
          if (!acceptance.accepted) return refused(acceptance.reason);
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
        return error instanceof OperationError && error.category === "unauthenticated"
          ? Object.freeze({ ok: false, error: publicError(error) }) : refused("invalid_credential");
      }
    },
  });
}
