import type { ControllerLock } from "../controller-lock";

interface Closer { close(): void | Promise<void> }

/** Restore failures must join the original handoff before releasing its owner. */
export function createControllerRestoreFailure(deps: {
  shutdown(handoff: boolean): Promise<void>;
  controllerLock: ControllerLock;
  report(message: string): void;
  exit(code: number): void;
}) {
  return async (error: unknown): Promise<void> => {
    deps.report(error instanceof Error ? error.message : "Restore handoff failed.");
    try {
      await deps.shutdown(true);
      deps.controllerLock.release();
      deps.exit(1);
    } catch {
      // No forced exit or lock release while resources may still be owned.
      deps.report("Restore cleanup is unconfirmed; ownership retained. Operator recovery is required.");
    }
  };
}

/** Owning CLI shutdown sequence. Kept separate so isolated fixtures can exercise its ordering. */
export function createControllerShutdown(deps: {
  service: { closeAdmission(): void; shutdown(): Promise<void> };
  stopping(): void;
  userSchedules: Closer | undefined;
  backups: Closer;
  remoteVerification: Closer | null;
  mcp: Closer | null;
  controller: Closer;
  adminSocket: Closer;
  removeServiceAccess(): void;
  controllerLock: ControllerLock;
}) {
  let completion: Promise<void> | undefined;
  let selectedHandoff = false;
  return (handoff = false): Promise<void> => {
    if (completion) {
      // A normal stop cannot later promise to retain ownership for a restore.
      if (handoff !== selectedHandoff) return Promise.reject(new Error("Controller shutdown mode cannot change after shutdown starts."));
      return completion;
    }
    selectedHandoff = handoff;
    let resolve!: () => void, reject!: (error: unknown) => void;
    completion = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Publish the promise before invoking any dependency, including synchronous closers.
    void (async () => {
      try {
        // Fence synchronously; listeners then drain already accepted responses.
        deps.service.closeAdmission();
        deps.stopping();
        const failures: unknown[] = [];
        for (const closer of [deps.userSchedules, deps.backups]) {
          try { await closer?.close(); } catch (error) { failures.push(error); }
        }
        const listeners = await Promise.allSettled(
          [deps.remoteVerification, deps.mcp, deps.controller, deps.adminSocket]
            .map(closer => Promise.resolve().then(() => closer?.close())),
        );
        failures.push(...listeners.filter(result => result.status === "rejected").map(result => result.reason));
        // Never close SQLite while a producer/listener might still use it.
        if (failures.length) throw new AggregateError(failures);
        await deps.service.shutdown();
        deps.removeServiceAccess();
        if (!handoff) deps.controllerLock.release();
      } catch (error) {
        // Retain failure as well as ownership: later calls cannot report a false success.
        throw new AggregateError([error], "Controller shutdown did not complete cleanly.");
      }
    })().then(resolve, reject);
    return completion;
  };
}
