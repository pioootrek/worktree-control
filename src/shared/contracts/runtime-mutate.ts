import { z } from "zod";
import type { ScopedOwnClaim, ScopedRuntimeReceipt } from "./runtime-access";
const id = z.string().min(1).max(160);
const base = { projectId: id, idempotencyKey: z.string().trim().min(1).max(120) };
const ttlSeconds = z.number().int().min(30).max(1800).default(1800);
export const runtimeMutateSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("claim"), worktreePath: z.string().min(1).max(2048),
    reason: z.string().trim().min(1).max(240), ttlSeconds, start: z.boolean().default(false) }).strict(),
  z.object({ ...base, operation: z.literal("renew"), reservationId: id, ttlSeconds }).strict(),
  z.object({ ...base, operation: z.literal("release"), reservationId: id }).strict(),
  ...(["start", "restart", "stop"] as const).map(operation => z.object({ ...base, operation: z.literal(operation), reservationId: id }).strict()),
]);
export type RuntimeMutateRequest = z.infer<typeof runtimeMutateSchema>;
export type RuntimeMutateResult =
  | { operation: "claim"; projectId: string; claim: ScopedOwnClaim; startRequested: boolean; error: {code:string;message:string} | null; replayed: boolean }
  | { operation: "renew"; projectId: string; claim: ScopedOwnClaim; replayed: boolean }
  | { operation: "release"; projectId: string; reservationId: string; released: true; replayed: boolean }
  | { operation: "start" | "restart" | "stop"; receipt: ScopedRuntimeReceipt; replayed: boolean };
