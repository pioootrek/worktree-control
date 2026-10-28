import { z } from "zod";
import type { RuntimeAction } from "./runtime-access";

export const knowledgePermissions = [
  "knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export", "knowledge:import",
  "attachments:read", "attachments:write",
] as const;
export type KnowledgePermission = typeof knowledgePermissions[number];
export type SubjectKind = "human" | "agent" | "worker" | "installation";
export type KnowledgeRole = "reader" | "operator" | "manager";
export interface KnowledgeRoleBinding {
  principalId: string;
  projectId: string;
  role: KnowledgeRole;
  revision: number;
  updatedAt: string;
  revokedAt: string | null;
}

/** Resource namespaces cannot be substituted even when their IDs happen to match. */
export type AuthorizationResource =
  | { kind: "knowledge-project"; id: string }
  | { kind: "runtime-project"; id: string }
  | { kind: "dev-vault"; id: string };
export type AuthorizationAction = KnowledgePermission | RuntimeAction | "env:read" | "env:write" | "env:use";

const bindingTarget = {
  principalId: z.string().min(1).max(160),
  projectId: z.string().min(1).max(160),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
};
export const setKnowledgeRoleSchema = z.object({
  ...bindingTarget, role: z.enum(["reader", "operator", "manager"]),
}).strict();
export const revokeKnowledgeRoleSchema = z.object(bindingTarget).strict();
export const listKnowledgeRolesSchema = z.object({ principalId: bindingTarget.principalId }).strict();
