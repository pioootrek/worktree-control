import { z } from "zod";

/** Finite-queue preset used by managed Godot Web exports; not a discoverable test preset. */
export const GODOT_WEB_EXPORT_PRESET_ID = "godot:web-export";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RELATIVE_SEGMENT = /^[A-Za-z0-9_.@+ -]+$/;

/** A worktree-relative path without traversal, absolute roots, backslashes or the Git directory. */
export function isSafeRelativePath(value: string, allowRoot = false): boolean {
  if (allowRoot && value === ".") return true;
  if (!value || value.length > 240 || value.startsWith("/") || value.includes("\\") || CONTROL_CHARACTERS.test(value)) return false;
  const segments = value.replace(/\/+$/, "").split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && RELATIVE_SEGMENT.test(segment))
    && segments[0] !== ".git";
}

export function normalizeRelativePath(value: string): string {
  return value === "." ? "." : value.replace(/\/+$/, "");
}

const relativePath = (allowRoot = false) => z.string().trim().min(1).max(240)
  .refine((value) => isSafeRelativePath(value, allowRoot), "Use a worktree-relative path without '..', '.git' or an absolute root.")
  .transform(normalizeRelativePath);

const argument = z.string().min(1).max(512).refine((value) => !CONTROL_CHARACTERS.test(value), "Arguments cannot contain control characters.");
/** A bare program resolved through PATH, or an absolute executable configured on this installation. */
const godotExecutable = z.string().trim().min(1).max(255)
  .refine((value) => /^[A-Za-z0-9._+-]+$/.test(value) || (value.startsWith("/") && !CONTROL_CHARACTERS.test(value) && !value.split("/").includes("..")),
    "Use a program name from PATH or an absolute executable path.");
/** argv[0] is a program from PATH or a project-owned, worktree-relative script. */
const commandProgram = z.string().trim().min(1).max(240)
  .refine((value) => /^[A-Za-z0-9._+-]+$/.test(value) || (value.includes("/") && isSafeRelativePath(value.replace(/^\.\//, ""))),
    "Use a program name from PATH or a worktree-relative script.");

export const godotWebExporterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preset"),
    preset: z.string().trim().min(1).max(80).refine((value) => !CONTROL_CHARACTERS.test(value) && !value.includes('"'), "Invalid export preset name."),
    godotExecutable: godotExecutable.default("godot"),
  }).strict(),
  z.object({
    kind: z.literal("command"),
    command: z.tuple([commandProgram], argument).refine((value) => value.length <= 32, "At most 32 command arguments."),
    outputDirectory: relativePath(),
  }).strict(),
]);

export const godotWebConfigSchema = z.object({
  version: z.literal(1).default(1),
  exporter: godotWebExporterSchema,
  watch: z.object({
    paths: z.array(relativePath(true)).min(1).max(16).default(["."]),
    ignore: z.array(relativePath()).max(64).default([]),
    debounceMs: z.number().int().min(100).max(10_000).default(750),
  }).strict().default({ paths: ["."], ignore: [], debounceMs: 750 }),
  liveReload: z.boolean().default(true),
  crossOriginIsolation: z.boolean().default(true),
}).strict();

export type GodotWebConfig = z.output<typeof godotWebConfigSchema>;
export type GodotWebConfigInput = z.input<typeof godotWebConfigSchema>;

export const DEFAULT_GODOT_WEB_CONFIG: GodotWebConfig = godotWebConfigSchema.parse({
  exporter: { kind: "preset", preset: "Web" },
});

export type WebExportState = "stopped" | "idle" | "queued" | "building" | "ready" | "failed";
export type WebExportWatcherState = "stopped" | "watching" | "limit_exceeded" | "unavailable";
export type WebExportFailureCode =
  | "configuration_invalid" | "queue_rejected" | "export_failed" | "export_timed_out" | "export_cancelled"
  | "superseded" | "output_invalid" | "publication_failed";

/** One immutable, completely copied export generation. Paths are intentionally absent. */
export interface WebExportGeneration {
  id: string;
  publishedAt: string;
  runId: string;
  head: string | null;
  dirty: boolean | null;
  files: number;
  bytes: number;
}

export interface WebExportStatus {
  state: WebExportState;
  watcher: WebExportWatcherState;
  worktreePath: string | null;
  current: WebExportGeneration | null;
  /** The served generation predates a known source change or a build in progress. */
  currentStale: boolean;
  activeRunId: string | null;
  pendingRebuild: boolean;
  lastRunId: string | null;
  lastChangeAt: string | null;
  lastFailure: { code: WebExportFailureCode; message: string; runId: string | null; at: string } | null;
}

/** Parses input with a safe, single-line error suitable for HTTP, MCP and CLI. */
export function parseGodotWebConfig(input: unknown): GodotWebConfig {
  const result = godotWebConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "configuration";
  throw new Error(`Invalid Godot Web configuration (${path}): ${issue?.message ?? "invalid value"}`);
}
