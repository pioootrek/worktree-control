import { SECURITY_TABLES, securityTriggers } from "./security-fence-migration";
import { UPGRADE_MARKER_SECURITY_TABLES, upgradeMarkerTriggers } from "./upgrade-marker-migration";

/**
 * Fence coverage per schema step: the frozen schema-49 list first, then each
 * later step's own additions. The expected triggers of a database are those of
 * every entry up to its version.
 */
export const SECURITY_COVERAGE: ReadonlyArray<{ version: number; tables: readonly string[]; triggers: ReadonlyArray<{ name: string; sql: string }> }> = [
  { version: 49, tables: SECURITY_TABLES, triggers: securityTriggers },
  { version: 50, tables: UPGRADE_MARKER_SECURITY_TABLES, triggers: upgradeMarkerTriggers },
];

export function securityTriggersAt(version: number): Array<{ name: string; sql: string }> {
  return SECURITY_COVERAGE.filter(step => step.version <= version).flatMap(step => [...step.triggers]);
}
