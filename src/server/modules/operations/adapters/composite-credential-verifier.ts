import type { AcceptedPath } from "../acceptance";
import type { CredentialIdentity, CredentialVerifier, VerifiedCredential } from "../authentication-context";
import { settled } from "./credential-values";

/** All options required; an explicitly absent half is null. The provider half is the existing ProviderSessionVerifier. */
export interface CompositeCredentialVerifierOptions {
  installation: CredentialVerifier | null;
  agent: CredentialVerifier | null;
  providerSession: CredentialVerifier | null;
}

/** Dispatch by accepted path only, without fallback. Operator authority belongs to the boundary, never a verifier. */
export class CompositeCredentialVerifier implements CredentialVerifier {
  readonly #installation: CredentialVerifier | null;
  readonly #agent: CredentialVerifier | null;
  readonly #providerSession: CredentialVerifier | null;
  constructor(options: CompositeCredentialVerifierOptions) {
    if (!options || [options.installation, options.agent, options.providerSession].some(half => half !== null
      && (typeof half?.verify !== "function" || typeof half?.current !== "function"))) throw new TypeError("Invalid composite credential verifier options.");
    this.#installation = options.installation;
    this.#agent = options.agent;
    this.#providerSession = options.providerSession;
  }

  verify(path: AcceptedPath, secret: string | null): VerifiedCredential | null {
    try { return this.#answer(path, this.#half(path)?.verify(path, secret) ?? null); } catch { return null; }
  }

  current(identity: CredentialIdentity): VerifiedCredential | null {
    try { return this.#answer(identity.path, this.#half(identity.path)?.current(identity) ?? null); } catch { return null; }
  }

  #half(path: AcceptedPath): CredentialVerifier | null {
    switch (path) {
      case "anonymous_installation": case "installation_token": return this.#installation;
      case "agent_token": return this.#agent;
      case "provider_session": return this.#providerSession;
      default: return null;
    }
  }

  #answer(path: AcceptedPath, value: VerifiedCredential | null): VerifiedCredential | null {
    const answer = settled(value);
    return answer && answer.identity.path === path ? answer : null;
  }
}
