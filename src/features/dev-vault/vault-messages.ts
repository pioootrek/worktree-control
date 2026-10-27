import type { Translate } from "@/i18n/messages";
import type { VaultErrorCode } from "./vault-model";

/** Fixed, value-free text for every failure. Server responses only contribute their code. */
export function vaultErrorMessage(t: Translate, code: VaultErrorCode): string {
  return t(`vault.error.${code}`);
}
