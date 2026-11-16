import { SECURITY_TABLES, securityTriggers } from "./security-fence-migration";
import { UPGRADE_MARKER_SECURITY_TABLES, upgradeMarkerTriggers } from "./upgrade-marker-migration";
import { PROJECT_MAPPING_SECURITY_TABLES, projectMappingFenceTriggers, projectMappingTriggers } from "./mapping-structure-migration";

type Trigger = { name: string; sql: string };

/**
 * Fence coverage per schema step: the frozen schema-49 list first, then each
 * later step's own additions. The expected triggers of a database are those of
 * every entry up to its version.
 */
export const SECURITY_COVERAGE: ReadonlyArray<{ version: number; tables: readonly string[]; triggers: ReadonlyArray<Trigger> }> = [
  { version: 49, tables: SECURITY_TABLES, triggers: securityTriggers },
  { version: 50, tables: UPGRADE_MARKER_SECURITY_TABLES, triggers: upgradeMarkerTriggers },
  { version: 51, tables: PROJECT_MAPPING_SECURITY_TABLES, triggers: projectMappingFenceTriggers },
];

/**
 * Triggers other than the fence's, per schema step (none before 51): the
 * project-mapping stamping, immutability and append-only guards. Together
 * with {@link SECURITY_COVERAGE} they are every trigger a database of that
 * version has, and recognition accepts no other.
 */
export const STEP_TRIGGERS: ReadonlyArray<{ version: number; triggers: ReadonlyArray<Trigger> }> = [
  { version: 51, triggers: projectMappingTriggers },
];

export function securityTriggersAt(version: number): Trigger[] {
  return SECURITY_COVERAGE.filter(step => step.version <= version).flatMap(step => [...step.triggers]);
}

/** Every trigger of a database at `version`, with the step that adds it: fence coverage first. */
export function schemaTriggersAt(version: number): Array<Trigger & { step: number }> {
  return [...SECURITY_COVERAGE, ...STEP_TRIGGERS].filter(step => step.version <= version)
    .flatMap(step => step.triggers.map(trigger => ({ ...trigger, step: step.version })));
}
