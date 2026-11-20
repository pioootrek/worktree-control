import type { DatabaseAdmissionOptions } from "../database-admission";
import type { ControllerLock } from "../controller-lock";
import { buildOperationsRuntime, type OperationsRuntimeOptions } from "./operations-runtime";
import { OperationError, publicError } from "../modules/operations";

/** Prepared for the offline CLI; no production caller mounts this composition yet. */
export function buildOfflineOperationsRuntime(options: Omit<OperationsRuntimeOptions, "listeners" | "provider"> & {
  controllerLock: ControllerLock;
}) {
  const { controllerLock, ...runtimeOptions } = options;
  const runtime = buildOperationsRuntime({ ...runtimeOptions, listeners: {}, provider: null });
  const mintOffline = (admission: DatabaseAdmissionOptions) => {
    if (runtime.supported && (!runtime.eligible() || !controllerLock.held())) return Promise.resolve(Object.freeze({ ok: false as const,
      error: publicError(new OperationError("unauthenticated", "offline_lock_not_held")) }));
    return runtime.mintOffline(() => controllerLock.held(), admission);
  };
  // Preserve the supported discriminator and the ordinary runner's revalidation/release policy.
  return runtime.supported ? Object.freeze({ ...runtime, mintOffline }) : Object.freeze({ ...runtime, mintOffline });
}
