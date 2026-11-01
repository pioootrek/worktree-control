import type { AuthenticationService } from "./authentication-service";

export type AuthenticationCommand =
  | { command: "status" }
  | { command: "token generate" }
  | { command: "token rotate" }
  | { command: "mode set"; value: string };

export const AUTHENTICATION_COMMAND_USAGE = "Available auth commands: status, token generate, token rotate, mode set <open|token|better-auth>";

/** Strictly parses CLI arguments or an admin-channel request; anything else is rejected. */
export function parseAuthenticationCommand(value: unknown): AuthenticationCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(AUTHENTICATION_COMMAND_USAGE);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record.command === "mode set" && keys === "command,value" && typeof record.value === "string" && record.value.length <= 32) {
    return { command: "mode set", value: record.value };
  }
  if ((record.command === "status" || record.command === "token generate" || record.command === "token rotate") && keys === "command") {
    return { command: record.command };
  }
  throw new Error(AUTHENTICATION_COMMAND_USAGE);
}

export function authenticationCommandFromArgs(args: string[]): AuthenticationCommand {
  const [group, action, value, ...rest] = args;
  if (group === "status" && action === undefined) return { command: "status" };
  if (group === "token" && (action === "generate" || action === "rotate") && value === undefined) return { command: `token ${action}` };
  if (group === "mode" && action === "set" && value !== undefined && rest.length === 0) return { command: "mode set", value };
  throw new Error(AUTHENTICATION_COMMAND_USAGE);
}

/** Runs one administrator command. Configuration selection and immediate credential invalidation are separate effects. */
export function executeAuthenticationCommand(
  service: AuthenticationService,
  request: AuthenticationCommand,
  actor: string,
): { result: unknown; configurationChanged: boolean; credentialsInvalidated: boolean } {
  switch (request.command) {
    case "status":
      return { result: service.status(), configurationChanged: false, credentialsInvalidated: false };
    case "token generate":
      // A new token changes nothing that existing sessions rely on.
      return { result: service.generateToken(actor), configurationChanged: false, credentialsInvalidated: false };
    case "token rotate":
      return { result: service.rotateToken(actor), configurationChanged: false, credentialsInvalidated: true };
    case "mode set": {
      const before = service.status().configuredMode;
      const result = service.setMode(request.value, actor);
      return { result, configurationChanged: result.configuredMode !== before, credentialsInvalidated: false };
    }
  }
}
