import { executeAuthenticationCommand, parseAuthenticationCommand, type AuthenticationService } from "./modules/authentication";

/** Admin-socket handler: applies one command and ends derived sessions when the policy changes. */
export function authenticationAdminHandler(dependencies: {
  authentication: AuthenticationService;
  closeMcpSessions: () => Promise<void>;
  disconnectEvents: () => void;
  onPolicyChanged?: (command: string) => void;
}): (body: unknown) => Promise<unknown> {
  return async (body) => {
    const request = parseAuthenticationCommand(body);
    const { result, policyChanged } = executeAuthenticationCommand(dependencies.authentication, request, "local-admin");
    if (policyChanged) {
      // Clients reconnect and authenticate under the new policy; nothing else is stopped.
      await dependencies.closeMcpSessions();
      dependencies.disconnectEvents();
      dependencies.onPolicyChanged?.(request.command);
    }
    return result;
  };
}
