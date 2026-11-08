import { executeAuthenticationCommand, parseAuthenticationCommand, type AuthenticationService } from "./modules/authentication";

/** Admin-socket handler: applies one command and ends derived sessions when credentials are invalidated. */
export function authenticationAdminHandler(dependencies: {
  authentication: AuthenticationService;
  /** Checked inside admission, including after waiting behind provider work. */
  maintenance?: () => boolean;
  closeMcpSessions: () => Promise<void>;
  disconnectEvents: () => void;
  onPolicyChanged?: (command: string) => void;
}): (body: unknown) => Promise<unknown> {
  return async (body) => {
    if (dependencies.maintenance?.()) throw new Error("Controller is in maintenance.");
    const request = parseAuthenticationCommand(body);
    if (request.command === "mode set" && request.value === "better-auth") {
      await dependencies.authentication.prepareAccountMode();
      if (dependencies.maintenance?.()) throw new Error("Controller is in maintenance.");
    }
    const { result, credentialsInvalidated } = executeAuthenticationCommand(dependencies.authentication, request, "local-admin");
    if (credentialsInvalidated) {
      // Rotation is already committed; per-operation checks reject the old token immediately.
      await dependencies.closeMcpSessions();
      dependencies.disconnectEvents();
      dependencies.onPolicyChanged?.(request.command);
    }
    return result;
  };
}
