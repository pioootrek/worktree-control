/**
 * Process-wide switch for provisional schema steps (integration branch only).
 * Off by default; nothing here runs at import time. While it is off,
 * `schemaTarget` in `migration-registry.ts` refuses every target or ceiling
 * above `SUPPORTED_SCHEMA_VERSION`, however the value reaches it.
 *
 * Only tests turn it on. `provisional-schema.test.ts` refuses an import of this
 * module from any non-test source file under `src/` except the one module that
 * reads the switch; see that test for what the guard does and does not cover.
 */
let enabled = false;

/**
 * Turns provisional steps on and returns a function that restores the previous
 * state. Tests call it in their setup and call the result in their teardown.
 */
export function enableProvisionalSchema(): () => void {
  const previous = enabled;
  enabled = true;
  return () => { enabled = previous; };
}

/** Whether provisional steps may be applied or recognised in this process. */
export function provisionalSchemaEnabled(): boolean {
  return enabled;
}
