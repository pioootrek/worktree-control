import { describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import type { AuthenticationMode } from "./contracts";
import { resolveControllerAuthentication } from "./controller-authentication";

const INSTALLATION = `wsi_11111111-1111-4111-8111-111111111111_${"a".repeat(64)}`;
const SCOPED = `wts_22222222-2222-4222-8222-222222222222_${"b".repeat(64)}`;
const installationActor: AuthenticatedPrincipal = {
  principalId: "installation", principalKind: "installation", credentialId: "11111111-1111-4111-8111-111111111111", authenticationMethod: "installation_token",
};
const anonymousActor: AuthenticatedPrincipal = {
  principalId: "installation", principalKind: "installation", credentialId: "open", authenticationMethod: "none",
};
const agentActor: AuthenticatedPrincipal = {
  principalId: "agent-1", principalKind: "agent", credentialId: "22222222-2222-4222-8222-222222222222", authenticationMethod: "agent_token",
};

function resolve(mode: AuthenticationMode, bearer: string | null, legacy = false) {
  return resolveControllerAuthentication({
    authentication: {
      mode: () => mode,
      authenticateInstallation: (token) => mode === "token" && token === INSTALLATION ? installationActor : null,
      anonymousInstallation: () => mode === "open" ? anonymousActor : null,
    },
    identity: {
      authenticateBearer: (token) => {
        if (token !== SCOPED) throw new Error("invalid");
        return agentActor;
      },
    },
  }, { bearer, legacySecretValid: () => legacy });
}

describe("controller credential resolution", () => {
  it("accepts legacy secrets only in legacy mode and the installation token only in token mode", () => {
    expect(resolve("legacy", null, true)).toEqual({ kind: "legacy" });
    expect(resolve("legacy", INSTALLATION)).toBeNull();
    expect(resolve("token", null, true)).toBeNull();
    expect(resolve("token", INSTALLATION)).toEqual({ kind: "installation", actor: installationActor });
    expect(resolve("token", `${INSTALLATION.slice(0, -1)}0`)).toBeNull();
  });

  it("keeps scoped credentials in legacy and token modes", () => {
    expect(resolve("legacy", SCOPED)).toEqual({ kind: "principal", actor: agentActor });
    expect(resolve("token", SCOPED)).toEqual({ kind: "principal", actor: agentActor });
    expect(resolve("token", "wts_forged")).toBeNull();
  });

  it("treats every caller as the anonymous installation authority in open mode", () => {
    for (const [bearer, legacy] of [[null, false], [null, true], [INSTALLATION, false], [SCOPED, false], ["garbage", false]] as const) {
      expect(resolve("open", bearer, legacy)).toEqual({ kind: "installation", actor: anonymousActor });
    }
  });

  it("never falls back for a provider without enforcement", () => {
    for (const mode of ["better-auth"] as const) {
      expect(resolve(mode, null, true)).toBeNull();
      expect(resolve(mode, INSTALLATION)).toBeNull();
      expect(resolve(mode, SCOPED)).toBeNull();
      expect(resolve(mode, null)).toBeNull();
    }
  });

  it("treats a missing authentication service as legacy mode", () => {
    expect(resolveControllerAuthentication({}, { bearer: null, legacySecretValid: () => true })).toEqual({ kind: "legacy" });
    expect(resolveControllerAuthentication({}, { bearer: INSTALLATION, legacySecretValid: () => true })).toBeNull();
  });
});
