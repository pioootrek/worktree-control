import { randomUUID } from "node:crypto";
import { DEV_VAULT_DISCLAIMER, devVaultRequestSchema, type DevUseBinding, type DevVaultCommand } from "@/shared/contracts/dev-vault";
import type { AuthenticatedPrincipal, IdentityService } from "../identity";
import { DevVaultCipher, canonicalJson } from "./crypto";
import { DevVaultError, type DevVaultKeyProvider, type DevVaultOwnerVerifier, type DevVaultStore } from "./contracts";
import { parseDevDotenv } from "./dotenv";

interface Profile { id: string; revision: number; payload: string; createdAt: string; updatedAt: string }
interface Request {
  id: string; agentId: string; credentialId: string; profileId: string; revision: number;
  permission: "read" | "write" | "use"; proposal?: Record<string, string>; source?: "inline-dotenv"; binding?: DevUseBinding;
  status: "pending" | "approved" | "rejected"; createdAt: string; expiresAt: string;
}
interface Grant {
  id: string; requestId: string; lifetime: "once" | "15-minutes" | "until-revoked";
  createdAt: string; expiresAt: string | null; revokedAt: string | null; consumedBy: string | null;
}
interface Receipt {
  principalId: string; credentialId: string; command: DevVaultCommand; result: unknown; createdAt: string;
}
interface Audit { operation: DevVaultCommand["operation"]; actorId: string; at: string; profileId?: string; requestId?: string; grantId?: string }
interface VaultState { profiles: Profile[]; requests: Request[]; grants: Grant[]; receipts: Receipt[]; audit: Audit[] }
const empty = (): VaultState => ({ profiles: [], requests: [], grants: [], receipts: [], audit: [] });
const denied = (): never => { throw new DevVaultError("vault_denied"); };
const conflict = (): never => { throw new DevVaultError("vault_conflict"); };
const limit = (): never => { throw new DevVaultError("vault_limit"); };
const DAY = 86_400_000;
export const DEV_VAULT_STATE_BYTES = 4 * 1024 * 1024;

function publicProfile(profile: Profile) {
  return { profileId: profile.id, revision: profile.revision, createdAt: profile.createdAt, updatedAt: profile.updatedAt, environment: "DEV" as const };
}
function publicRequest(request: Request) {
  const { proposal: _proposal, ...metadata } = request;
  // Variable names and values stay out of ordinary request lists.
  void _proposal;
  return metadata;
}

/** Synchronous vault transaction, invoked under DevVaultOperations' shared lifecycle admission online. */
export class DevVaultService {
  private readonly cipher: DevVaultCipher;
  constructor(
    private readonly store: DevVaultStore,
    keys: DevVaultKeyProvider,
    private readonly identity: Pick<IdentityService, "describeIdentity">,
    private readonly ownerVerifier: DevVaultOwnerVerifier,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
    /** Restore fences deny grants/receipts from before an admitted controller restore. */
    private readonly restoreBoundary: () => string | null = () => null,
  ) { this.cipher = new DevVaultCipher(keys); }

  execute(raw: unknown, actor: AuthenticatedPrincipal): { disclaimer: string; result: unknown } {
    try { return { disclaimer: DEV_VAULT_DISCLAIMER, result: this.executeChecked(raw, actor) }; }
    catch (error) {
      if (error instanceof DevVaultError) throw error;
      // Includes authentication, provider, SQLite and parser failures; never echo their input/messages.
      throw new DevVaultError("vault_unavailable");
    }
  }

  private executeChecked(raw: unknown, actor: AuthenticatedPrincipal): unknown {
    const parsed = devVaultRequestSchema.safeParse(raw);
    if (!parsed.success) throw new DevVaultError("vault_invalid_request");
    const { command, proof } = parsed.data;
    try { this.identity.describeIdentity(actor); } catch { return denied(); }
    if (actor.principalKind !== "owner" && actor.principalKind !== "agent") return denied();
    if (actor.principalKind === "agent" && actor.authenticationMethod !== "agent_token") return denied();
    const now = this.clock();
    const owner = actor.principalKind === "owner";
    const ownerProof = owner ? this.ownerVerifier.verify(command, actor, proof, now) : null;
    if (owner && ownerProof !== "valid" && ownerProof !== "expired") return denied();
    if (!this.store.projectExists(command.projectId)) return denied();
    const fence = this.restoreBoundary();
    if (owner && fence !== null && (!proof || !(Date.parse(proof.issuedAt) > Date.parse(fence)))) return denied();
    if (ownerProof === "expired") throw new DevVaultError("vault_proof_expired");
    this.cipher.assertAvailable();
    const snapshot = this.store.load(command.projectId);
    const state = snapshot ? this.cipher.open<VaultState>(snapshot.ciphertext, command.projectId, "state", snapshot.version) : empty();
    const current = (createdAt: string) => fence === null || createdAt > fence;
    // Expired state can never authorize a request after reopen. Keep active grants and their requests.
    state.grants = state.grants.filter(g => !g.revokedAt && (!g.expiresAt || g.expiresAt > now) && current(g.createdAt));
    state.requests = state.requests.filter(r => (r.status === "pending" && r.expiresAt > now && current(r.createdAt)) || state.grants.some(g => g.requestId === r.id));
    state.receipts = state.receipts.filter(r => Date.parse(now) - Date.parse(r.createdAt) < DAY && current(r.createdAt));
    const requireOwner = () => { if (!owner) denied(); };
    const profile = (id: string, revision?: number) => {
      const found = state.profiles.find(p => p.id === id);
      if (!found) return denied();
      if (revision !== undefined && found.revision !== revision) return conflict();
      return found;
    };
    const request = (id: string) => {
      const found = state.requests.find(r => r.id === id);
      if (!found) return denied();
      return found;
    };
    const authorizeGrant = (grantId: string, permission: Request["permission"]) => {
      if (owner) return denied();
      const grant = state.grants.find(g => g.id === grantId);
      if (!grant) return denied();
      const proposal = request(grant.requestId);
      if (proposal.agentId !== actor.principalId || proposal.credentialId !== actor.credentialId || proposal.permission !== permission) return denied();
      // Write retries return metadata after advancing the revision. New writes check below.
      if (permission !== "write") profile(proposal.profileId, proposal.revision);
      if (grant.lifetime === "once" && grant.consumedBy !== null && grant.consumedBy !== command.operationId) return denied();
      return { grant, proposal };
    };
    const readEnvironment = (p: Profile) => this.cipher.open<Record<string, string>>(p.payload, command.projectId, p.id, p.revision);
    const savePatch = (p: Profile, patch: Record<string, string>) => {
      const environment = { ...readEnvironment(p), ...patch };
      if (Object.keys(environment).length > 100 || Buffer.byteLength(canonicalJson(environment)) > 48 * 1024) return limit();
      p.revision++;
      p.payload = this.cipher.seal(environment, command.projectId, p.id, p.revision);
      p.updatedAt = now;
      return publicProfile(p);
    };
    // Check live authorization BEFORE an idempotent plaintext replay, including revocation and expiry.
    let access: ReturnType<typeof authorizeGrant> | undefined;
    if (command.operation === "read" && !owner) {
      access = authorizeGrant(command.grantId ?? "", "read");
      if (access.proposal.profileId !== command.profileId || access.proposal.revision !== command.revision) return denied();
    }
    if (command.operation === "write") access = authorizeGrant(command.grantId, "write");
    if (command.operation === "use") {
      access = authorizeGrant(command.grantId, "use");
      if (access.proposal.profileId !== command.profileId || access.proposal.revision !== command.revision
        || canonicalJson(access.proposal.binding) !== canonicalJson(command.binding)) return denied();
      // No source-isolated finite-job admission exists yet. A grant is not execution evidence.
      throw new DevVaultError("vault_use_unavailable");
    }
    const existing = state.receipts.find(r => r.command.operationId === command.operationId);
    if (existing) {
      if (existing.principalId !== actor.principalId || existing.credentialId !== actor.credentialId || canonicalJson(existing.command) !== canonicalJson(command)) return conflict();
      // A committed write advances the profile; its metadata-only receipt remains replayable.
      return existing.result;
    }
    if (access?.grant.lifetime === "once" && access.grant.consumedBy !== null) return denied();

    let result: unknown;
    switch (command.operation) {
      case "list": requireOwner(); return { profiles: state.profiles.map(publicProfile), useAvailable: false };
      case "audit": requireOwner(); return { events: state.audit };
      case "requests": return { requests: state.requests.filter(r => owner || (r.agentId === actor.principalId && r.credentialId === actor.credentialId)).map(publicRequest),
        grants: state.grants.filter(g => owner || state.requests.some(r => r.id === g.requestId && r.agentId === actor.principalId && r.credentialId === actor.credentialId)) };
      case "inspect-request": requireOwner(); result = request(command.requestId); break;
      case "import": {
        requireOwner();
        if (state.profiles.length >= 16) return limit();
        const environment = parseDevDotenv(command.dotenv);
        const p: Profile = { id: this.id(), revision: 1, payload: "", createdAt: now, updatedAt: now };
        p.payload = this.cipher.seal(environment, command.projectId, p.id, p.revision);
        state.profiles.push(p); result = publicProfile(p); break;
      }
      case "update": requireOwner(); result = savePatch(profile(command.profileId, command.revision), parseDevDotenv(command.dotenv)); break;
      case "read": {
        const p = profile(command.profileId, command.revision);
        result = { ...publicProfile(p), environment: readEnvironment(p) }; break;
      }
      case "request": {
        if (owner) return denied();
        profile(command.profileId, command.revision);
        if (state.requests.length >= 64 || state.requests.filter(r => r.credentialId === actor.credentialId && r.status === "pending").length >= 8) return limit();
        if (command.permission === "write" ? command.dotenv === undefined || command.source !== "inline-dotenv" || command.binding !== undefined
          : command.dotenv !== undefined || command.source !== undefined || (command.permission === "use" ? command.binding === undefined : command.binding !== undefined)) {
          throw new DevVaultError("vault_invalid_request");
        }
        const r: Request = { id: this.id(), agentId: actor.principalId, credentialId: actor.credentialId,
          profileId: command.profileId, revision: command.revision, permission: command.permission,
          status: "pending", createdAt: now, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
          ...(command.permission === "write" ? { proposal: parseDevDotenv(command.dotenv!), source: "inline-dotenv" as const } : {}),
          ...(command.binding ? { binding: command.binding } : {}) };
        state.requests.push(r); result = publicRequest(r); break;
      }
      case "approve": {
        requireOwner();
        const r = request(command.requestId);
        if (r.status !== "pending" || r.expiresAt <= now) return denied();
        if (r.revision !== command.revision) return conflict();
        profile(r.profileId, r.revision);
        try { this.identity.describeIdentity({ principalId: r.agentId, credentialId: r.credentialId, principalKind: "agent", authenticationMethod: "agent_token" }); } catch { return denied(); }
        if (state.grants.length >= 64) return limit();
        r.status = "approved";
        const g: Grant = { id: this.id(), requestId: r.id, lifetime: command.lifetime, createdAt: now,
          expiresAt: command.lifetime === "until-revoked" ? null : new Date(Date.parse(now) + (command.lifetime === "once" ? DAY : 15 * 60_000)).toISOString(), revokedAt: null, consumedBy: null };
        state.grants.push(g); result = g; break;
      }
      case "reject": {
        requireOwner(); const r = request(command.requestId);
        if (r.status !== "pending") return denied();
        r.status = "rejected"; result = { requestId: r.id, status: r.status }; break;
      }
      case "revoke": {
        requireOwner(); const g = state.grants.find(g => g.id === command.grantId);
        if (!g) return denied();
        // Reclaim the authority in this commit, before charging its receipt and
        // audit event against the byte cap. A full vault must remain revocable.
        state.grants = state.grants.filter(grant => grant.id !== g.id);
        state.requests = state.requests.filter(request => request.id !== g.requestId);
        result = { grantId: g.id, revokedAt: now }; break;
      }
      case "write": {
        if (!access?.proposal.proposal) return denied();
        result = savePatch(profile(access.proposal.profileId, access.proposal.revision), access.proposal.proposal); break;
      }
    }
    if (access?.grant.lifetime === "once") access.grant.consumedBy = command.operationId;
    state.receipts.push({ principalId: actor.principalId, credentialId: actor.credentialId, command, result, createdAt: now });
    state.receipts = state.receipts.slice(-64);
    state.audit.push({ operation: command.operation, actorId: actor.principalId, at: now,
      ...("profileId" in command ? { profileId: command.profileId } : {}),
      ...("requestId" in command ? { requestId: command.requestId } : {}),
      ...("grantId" in command ? { grantId: command.grantId } : {}) });
    state.audit = state.audit.slice(-128);
    let stateBytes = Buffer.byteLength(canonicalJson(state));
    // Retained retries must not prevent withdrawal of authority. Keep this
    // revocation's receipt, but evict older receipts if its audit needs space.
    while (command.operation === "revoke" && stateBytes > DEV_VAULT_STATE_BYTES && state.receipts.length > 1) {
      state.receipts.shift();
      stateBytes = Buffer.byteLength(canonicalJson(state));
    }
    if (stateBytes > DEV_VAULT_STATE_BYTES) return limit();
    const version = snapshot?.version ?? 0;
    const ciphertext = this.cipher.seal(state, command.projectId, "state", version + 1);
    if (!this.store.commit(command.projectId, version, ciphertext)) return conflict();
    return result;
  }
}
