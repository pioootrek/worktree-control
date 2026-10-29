import type { ControllerLock } from "../controller-lock";

interface Closer { close(): void | Promise<void> }

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
  let closing = false;
  return async (handoff = false) => {
    if (closing) return;
    closing = true;
    // Cancel pending starts before closing listeners, which wait for their HTTP responses.
    deps.service.closeAdmission();
    deps.stopping();
    try {
      let backupFailure: unknown = null;
      try { deps.userSchedules?.close(); await deps.backups.close(); } catch (error) { backupFailure = error; }
      const listeners = await Promise.allSettled([deps.remoteVerification?.close(), deps.mcp?.close(), deps.controller.close(), deps.adminSocket.close()]);
      const listenerFailures = listeners.filter((result) => result.status === "rejected");
      let serviceFailure: unknown = null;
      try {
        await deps.service.shutdown();
      } catch (error) {
        serviceFailure = error;
      }
      const failures = [...(backupFailure ? [backupFailure] : []), ...listenerFailures.map((result) => result.reason), ...(serviceFailure ? [serviceFailure] : [])];
      if (failures.length) throw new AggregateError(failures, "Controller shutdown did not complete cleanly.");
    } finally {
      deps.removeServiceAccess();
      if (!handoff) deps.controllerLock.release();
    }
  };
}
