import { ENVIRONMENT_PREFIX, LEGACY_ENVIRONMENT_PREFIX } from "./product-environment";

/**
 * Controller credentials known by name: installation, owner, Knowledge and DEV
 * vault bearer tokens plus vault key-file locations. Both the current and the
 * pre-rename prefix are removed.
 */
const CONTROLLER_CREDENTIAL_SUFFIXES = [
  "TOKEN", "OWNER_TOKEN", "KNOWLEDGE_TOKEN", "DEV_VAULT_TOKEN",
  "DEV_VAULT_KEY_FILE", "DEV_VAULT_OWNER_PRIVATE_KEY_FILE", "DEV_VAULT_OWNER_PUBLIC_KEY_FILE",
] as const;
const CONTROLLER_CREDENTIALS = new Set(CONTROLLER_CREDENTIAL_SUFFIXES.flatMap(suffix => [
  `${ENVIRONMENT_PREFIX}${suffix}`, `${LEGACY_ENVIRONMENT_PREFIX}${suffix}`,
]));
/** Defensive match for future product credentials under either prefix. */
const PRODUCT_CREDENTIAL = /^WORKTREE_(?:CONTROL|SWITCHER)_.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|KEY_FILE)$/;

/**
 * Environment inherited by controller-started children. Removes NODE_ENV and
 * controller credentials. This is not OS isolation: project code running as the
 * same account remains inside the trusted deployment boundary.
 */
export function inheritedRuntimeEnvironment(): Omit<NodeJS.ProcessEnv, "NODE_ENV">;
export function inheritedRuntimeEnvironment<Value extends string | undefined>(
  environment: Readonly<Record<string, Value>>,
): Record<string, Value>;
export function inheritedRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== "NODE_ENV"
    && !CONTROLLER_CREDENTIALS.has(name) && !PRODUCT_CREDENTIAL.test(name)));
}
