import { z } from "zod";

/** Public browser DTOs. Private CLI status and provider-native records stay server-only. */
export interface BrowserAuthenticationStatus { mode: "legacy" | "open" | "token" | "better-auth"; loginAvailable: boolean }
export type BrowserSession = { authenticated: false } | {
  authenticated: true;
  principal: { id: string; kind: "owner" };
  expiresAt: string;
  authentication: { method: "password"; factors: 1 };
};
export const browserSignInSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();
export const browserSignOutSchema = z.object({}).strict();
export const browserChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) }).strict();
