/**
 * A current-authority denial. Unlike operational failures it is never folded into
 * a receipt or claim result: the operation stops and the caller receives no data.
 */
export class RuntimeAccessDenied extends Error {
  readonly code = "project_access_denied";
  constructor() {
    super("The project does not exist or this credential is not authorized for the requested action.");
    this.name = "RuntimeAccessDenied";
  }
}

/** Fixed, transport-safe failure for scoped callers; never carries foreign names, owners or capacity holders. */
export class ScopedRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScopedRuntimeError";
  }
}
