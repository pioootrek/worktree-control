import { readProductEnvironment } from "../server/product-environment";

type Environment = Readonly<Record<string, string | undefined>>;

export const OWNER_CREDENTIAL_VARIABLES = ["WORKTREE_CONTROL_OWNER_TOKEN", "WORKTREE_CONTROL_TOKEN"] as const;
export const KNOWLEDGE_CREDENTIAL_VARIABLES = ["WORKTREE_CONTROL_KNOWLEDGE_TOKEN", ...OWNER_CREDENTIAL_VARIABLES] as const;

export const OWNER_CREDENTIAL_REQUIRED = "The active authentication mode requires a credential. Set WORKTREE_CONTROL_OWNER_TOKEN to an active owner session or WORKTREE_CONTROL_TOKEN to the installation token.";
export const KNOWLEDGE_CREDENTIAL_REQUIRED = "The active authentication mode requires a credential. Set WORKTREE_CONTROL_KNOWLEDGE_TOKEN to a scoped agent token or owner session, or WORKTREE_CONTROL_TOKEN to the installation token.";

/**
 * Returns the first nonempty credential variable; each `WORKTREE_CONTROL_*` name falls back to its
 * deprecated `WORKTREE_SWITCHER_*` predecessor. Absence is not an error here: the controller's
 * active mode decides, so open mode proceeds anonymously and protected modes reject.
 */
export function cliCredential(environment: Environment, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readProductEnvironment(environment, name)?.trim();
    if (value) return value;
  }
  return undefined;
}
