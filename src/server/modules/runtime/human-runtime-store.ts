import type { HumanRuntimeAuthority } from "../identity";
import type { Reservation } from "@/shared/contracts";

/** Server-only persistence, using the controller's existing reservation table/connection. */
export interface HumanRuntimeLease {
  reservation: Reservation;
  authority: HumanRuntimeAuthority;
  fingerprint: string;
  released: boolean;
}
export interface HumanRuntimeIntent {
  fingerprint: string;
  membershipRevision: number;
  reservationId: string | null;
  state: "pending" | "complete";
  result: unknown;
}
export interface HumanRuntimeStore {
  begin(authority: HumanRuntimeAuthority, projectId: string, key: string, fingerprint: string): HumanRuntimeIntent | null;
  attach(authority: HumanRuntimeAuthority, key: string, reservationId: string): void;
  finish(authority: HumanRuntimeAuthority, key: string, result: unknown): void;
  claim(authority: HumanRuntimeAuthority, input: {
    projectId: string; worktreePath: string; reason: string; key: string; fingerprint: string; ttlSeconds: number;
  }): Reservation;
  lease(reservationId: string): HumanRuntimeLease | null;
  renew(reservationId: string, expiresAt: string): Reservation;
  release(reservationId: string, actor: string): void;
}
export const HUMAN_RUNTIME_LIMITS = Object.freeze({ intents: 4096, sessionIntents: 128, leases: 4096, receiptBytes: 8192 });
