import type { AuthenticatedPrincipal, ControllerAuthentication, IdentityService } from "@/server/modules/identity";
import type { AuthenticationMode } from "./contracts";

export interface ControllerCredentials {
  /** Bearer credential: an installation token or a scoped identity credential. */
  bearer: string | null;
  /** Whether the transport's legacy secret (pairing token or mcp-token) was presented. */
  legacySecretValid: () => boolean;
}

export interface ControllerAuthenticationDependencies {
  authentication?: {
    mode(): AuthenticationMode;
    authenticateInstallation(token: string): AuthenticatedPrincipal | null;
  };
  identity?: Pick<IdentityService, "authenticateBearer">;
}

/**
 * Resolves transport credentials under the active mode. Legacy secrets work only in `legacy`,
 * the installation token only in `token`; any other mode rejects both and never falls back.
 */
export function resolveControllerAuthentication(
  dependencies: ControllerAuthenticationDependencies,
  credentials: ControllerCredentials,
): ControllerAuthentication | null {
  const mode = dependencies.authentication?.mode() ?? "legacy";
  const { bearer } = credentials;
  if (bearer?.startsWith("wsi_")) {
    const actor = mode === "token" ? dependencies.authentication?.authenticateInstallation(bearer) : null;
    return actor ? { kind: "installation", actor } : null;
  }
  if (mode === "legacy" && credentials.legacySecretValid()) return { kind: "legacy" };
  if (!bearer || !dependencies.identity || (mode !== "legacy" && mode !== "token")) return null;
  try {
    return { kind: "principal", actor: dependencies.identity.authenticateBearer(bearer) };
  } catch {
    return null;
  }
}
