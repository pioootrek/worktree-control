import { randomUUID } from "node:crypto";
import {
  humanPageSchema, humanMembershipPageSchema, humanKnowledgeSetSchema, humanKnowledgeRevokeSchema,
  type HumanPage, type HumanMembershipPage, type HumanKnowledgeSet, type HumanKnowledgeRevoke, type HumanKnowledgeMembership,
} from "@/shared/contracts/human-accounts";
import type { Principal } from "./contracts";

export class HumanAccountError extends Error {
  constructor(readonly code: "principal_unavailable" | "membership_revision_conflict" | "invalid_input") {
    super(code === "membership_revision_conflict" ? "Human Knowledge membership revision changed; inspect current state." :
      code === "principal_unavailable" ? "The requested active human principal is unavailable." : "Invalid human account operation.");
  }
}
export interface HumanAccountStore {
  createHumanPrincipal(principal: Principal, actor: string): void;
  listHumanPrincipals(page: HumanPage): { items: Array<Principal & { enrollment: "absent" | "active" | "revoked" }>; nextAfter: string | null };
  disableHumanPrincipal(id: string, actor: string): { principal: Principal; changed: boolean };
  removeDisabledHumanSession(id: string): boolean;
  listHumanMemberships(page: HumanMembershipPage): { items: HumanKnowledgeMembership[]; nextAfter: string | null };
  saveHumanMembership(input: HumanKnowledgeSet | HumanKnowledgeRevoke, actor: string, now: string): HumanKnowledgeMembership;
}

/** Trusted local composition owns this service. No request actor/context is accepted. */
export class HumanAccountService {
  constructor(private readonly store: HumanAccountStore, private readonly actor: "local-cli" | "local-admin", private readonly clock = () => new Date().toISOString()) {}
  create(): Principal {
    const principal: Principal = { id: randomUUID(), kind: "human", status: "active" };
    this.store.createHumanPrincipal(principal, this.actor);
    return principal;
  }
  list(input: unknown) {
    const parsed = humanPageSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.listHumanPrincipals(parsed.data);
  }
  disable(id: string) {
    if (typeof id !== "string" || !id || id.length > 160) throw new HumanAccountError("invalid_input");
    return this.store.disableHumanPrincipal(id, this.actor);
  }
  /** Called under fresh core admission until false, after terminal disable committed. */
  reclaimDisabledSession(id: string): boolean { return this.store.removeDisabledHumanSession(id); }
  memberships(input: unknown) {
    const parsed = humanMembershipPageSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.listHumanMemberships(parsed.data);
  }
  set(input: unknown) {
    const parsed = humanKnowledgeSetSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.saveHumanMembership(parsed.data, this.actor, this.clock());
  }
  revoke(input: unknown) {
    const parsed = humanKnowledgeRevokeSchema.safeParse(input);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    return this.store.saveHumanMembership(parsed.data, this.actor, this.clock());
  }
}
