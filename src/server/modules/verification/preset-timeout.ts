import { z } from "zod";
import type { Project, TestPreset } from "@/shared/contracts";

// Keep setTimeout within its supported range; null removes the project override.
export const testPresetTimeoutSchema = z.object({
  presetId: z.string().trim().min(1).max(160).regex(/^(node|django|godot):[A-Za-z0-9._:-]+$/),
  timeoutMs: z.number().int().min(1).max(86_400_000).nullable(),
}).strict();

export function projectTestPreset(project: Project, preset: TestPreset): TestPreset {
  return { ...preset, timeoutMs: project.testPresetTimeouts[preset.id] ?? preset.timeoutMs };
}
