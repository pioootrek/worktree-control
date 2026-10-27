import type { DevVaultCommand } from "@/shared/contracts/dev-vault";
import { canonicalJson } from "@/shared/contracts/dev-vault-signing";
import { importOwnerSigningKey, signOwnerCommand } from "./owner-signer";
import { postDevVault, readOwnerIdentity, type OwnerIdentity } from "./vault-client";
import { proofTimestamp, VaultClientError } from "./vault-model";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Command fields after the shared `projectId`, `operationId` and `environment` members. */
export type VaultOperation = DistributiveOmit<DevVaultCommand, "projectId" | "operationId" | "environment">;
/** Runs one signed command for the current project. */
export type RunVault = (intent: string, operation: VaultOperation) => Promise<unknown>;
interface Session extends OwnerIdentity { token: string; key: CryptoKey }
export interface OwnerSessionDependencies { fetch?: typeof fetch; now?: () => number; operationId?: () => string }

/**
 * Transient owner proof state for one browser tab. It holds the owner session token and a
 * non-extractable signing key in memory only; `lock` drops both and any retry bookkeeping.
 */
export class OwnerVaultSession {
  private session: Session | null = null;
  private generation = 0;
  // Uncertain operations keep their operation ID so a retry replays a committed receipt.
  private readonly uncertain = new Map<string, DevVaultCommand>();
  constructor(private readonly dependencies: OwnerSessionDependencies = {}) {}

  private get send(): typeof fetch { return this.dependencies.fetch ?? ((input, init) => fetch(input, init)); }
  private now(): number { return (this.dependencies.now ?? Date.now)(); }
  private newOperationId(): string { return (this.dependencies.operationId ?? (() => crypto.randomUUID()))(); }

  get connected(): boolean { return this.session !== null; }
  ownerToken(): string | null { return this.session?.token ?? null; }

  lock(): void {
    this.generation += 1;
    this.session = null;
    this.uncertain.clear();
  }

  /** Verifies the owner session identity and imports the key; neither succeeds alone. */
  async connect(token: string, keyText: string): Promise<Omit<OwnerIdentity, "skewMs">> {
    this.lock();
    const started = this.generation;
    const value = token.trim();
    const [identity, key] = await Promise.all([readOwnerIdentity(value, this.send, () => this.now()), importOwnerSigningKey(keyText)]);
    if (this.generation !== started) throw new VaultClientError("locked");
    this.session = { ...identity, token: value, key };
    const { skewMs: _skew, ...visible } = identity;
    void _skew;
    return visible;
  }

  /** Signs and sends one owner command. `intent` groups retries of the same user action. */
  async run(projectId: string, intent: string, operation: VaultOperation): Promise<unknown> {
    const current = this.session;
    if (!current) throw new VaultClientError("locked");
    const started = this.generation;
    const previous = this.uncertain.get(intent);
    const build = (operationId: string) => ({ ...operation, projectId, operationId, environment: "DEV" }) as DevVaultCommand;
    let command = build(previous?.operationId ?? this.newOperationId());
    if (previous && canonicalJson(command) !== canonicalJson(previous)) command = build(this.newOperationId());
    this.uncertain.set(intent, command);
    try {
      const proof = await signOwnerCommand(current.key, command, current, proofTimestamp(this.now(), current.skewMs));
      const result = await postDevVault(current.token, command, proof, this.send);
      if (this.generation !== started) throw new VaultClientError("locked");
      this.uncertain.delete(intent);
      return result;
    } catch (error) {
      if (this.generation !== started) throw new VaultClientError("locked");
      if (!(error instanceof VaultClientError && error.retryable)) this.uncertain.delete(intent);
      throw error instanceof VaultClientError ? error : new VaultClientError("vault_unavailable");
    }
  }
}
