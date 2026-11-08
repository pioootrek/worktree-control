import {
  runtimeMembershipPageSchema, runtimeMembershipSetSchema, runtimeMembershipRevokeSchema,
  type RuntimeMembership, type RuntimeMembershipPage, type RuntimeMembershipSet, type RuntimeMembershipRevoke,
} from "@/shared/contracts/runtime-memberships";
import { HumanAccountError } from "./human-account-service";

export interface RuntimeMembershipStore {
  getRuntimeMembership(principalId: string, projectId: string): RuntimeMembership | null;
  listRuntimeMemberships(page: RuntimeMembershipPage): { items: RuntimeMembership[]; nextAfter: string | null };
  saveRuntimeMembership(input: RuntimeMembershipSet | RuntimeMembershipRevoke, actor: string, now: string): RuntimeMembership;
}

/** Protected local operator composition only. No caller-supplied actor or provider load. */
export class RuntimeMembershipService {
  constructor(private readonly store: RuntimeMembershipStore, private readonly actor: "local-cli" | "local-admin", private readonly clock = () => new Date().toISOString()) {}
  list(input: unknown) {
    const parsed = runtimeMembershipPageSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.listRuntimeMemberships(parsed.data);
  }
  set(input: unknown) {
    const parsed = runtimeMembershipSetSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.saveRuntimeMembership(parsed.data, this.actor, this.clock());
  }
  revoke(input: unknown) {
    const parsed = runtimeMembershipRevokeSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.saveRuntimeMembership(parsed.data, this.actor, this.clock());
  }
}
