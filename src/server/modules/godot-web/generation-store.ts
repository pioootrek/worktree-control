import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";

import { GENERATION_ID, SERVED_EXTENSIONS, SERVED_SEGMENT } from "@/server/infrastructure/godot-web";
import type { WebExportGeneration } from "@/shared/contracts/godot-web";

export { GENERATION_ID, SERVED_EXTENSIONS, SERVED_SEGMENT };

export interface GenerationLimits { maxFiles: number; maxBytes: number; maxDepth: number; retain: number }
export const DEFAULT_GENERATION_LIMITS: GenerationLimits = { maxFiles: 4096, maxBytes: 1024 * 1024 * 1024, maxDepth: 8, retain: 2 };

/** Path-free state the separate static server reads; it never contains host paths or logs. */
export interface PublicWebState {
  version: 1;
  generation: string | null;
  /** Opaque worktree identity; the server ignores a generation built for another worktree. */
  worktreeKey: string | null;
  publishedAt: string | null;
  build: "idle" | "queued" | "building" | "failed";
  failureCode: string | null;
  updatedAt: string;
}

/** Controller-only metadata kept outside the served tree. */
export interface GenerationMeta extends WebExportGeneration { worktreePath: string }

export class GenerationSupersededError extends Error {
  constructor() { super("session_ended"); }
}

export class GenerationOutputError extends Error {
  constructor(readonly code: "output_missing" | "output_entry_missing" | "output_limit" | "output_unsafe", message: string) { super(message); }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Per-project store below the controller state directory. A generation becomes
 * visible only after its complete copy is renamed into place and the public
 * state pointer is atomically replaced; failures leave the previous pointer intact.
 */
export class GenerationStore {
  readonly publicDirectory: string;
  readonly stagingDirectory: string;
  private readonly generations: string;
  private readonly incoming: string;
  private readonly meta: string;

  constructor(readonly root: string, private readonly limits: GenerationLimits = DEFAULT_GENERATION_LIMITS) {
    this.publicDirectory = join(root, "public");
    this.generations = join(this.publicDirectory, "generations");
    this.stagingDirectory = join(root, "staging");
    this.incoming = join(root, "incoming");
    this.meta = join(root, "meta");
  }

  async initialize(): Promise<void> {
    for (const directory of [this.root, this.publicDirectory, this.generations, this.meta]) await mkdir(directory, { recursive: true, mode: 0o700 });
    // Interrupted copies are never visible; remove them on every start.
    await rm(this.incoming, { recursive: true, force: true });
    await mkdir(this.incoming, { recursive: true, mode: 0o700 });
  }

  async resetStaging(): Promise<void> {
    await rm(this.stagingDirectory, { recursive: true, force: true });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
  }

  async readState(): Promise<PublicWebState> {
    try {
      const state = JSON.parse(await readFile(join(this.publicDirectory, "state.json"), "utf8")) as PublicWebState;
      if (state.version === 1 && (state.generation === null || GENERATION_ID.test(state.generation))) return state;
    } catch { /* missing or damaged pointer means nothing is published */ }
    return { version: 1, generation: null, worktreeKey: null, publishedAt: null, build: "idle", failureCode: null, updatedAt: new Date().toISOString() };
  }

  async writeState(update: Partial<Omit<PublicWebState, "version" | "updatedAt">>): Promise<PublicWebState> {
    const state = { ...(await this.readState()), ...update, version: 1 as const, updatedAt: new Date().toISOString() };
    await atomicJson(join(this.publicDirectory, "state.json"), state);
    return state;
  }

  async readMeta(id: string): Promise<GenerationMeta | null> {
    if (!GENERATION_ID.test(id)) return null;
    try { return JSON.parse(await readFile(join(this.meta, `${id}.json`), "utf8")) as GenerationMeta; }
    catch { return null; }
  }

  /**
   * Copies regular allowlisted files without following symlinks (O_NOFOLLOW on
   * every open), then publishes the generation. `containment` bounds the source.
   */
  async publish(source: string, containment: string, meta: Omit<GenerationMeta, "id" | "publishedAt" | "files" | "bytes">, worktreeKey: string, current: () => boolean | Promise<boolean> = () => true): Promise<{ generation: GenerationMeta; skipped: number }> {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const target = join(this.incoming, id);
    let files = 0, bytes = 0, skipped = 0;
    try {
      let info;
      try { info = await lstat(source); } catch { throw new GenerationOutputError("output_missing", "The export produced no output directory."); }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new GenerationOutputError("output_unsafe", "The export output must be a real directory.");
      const root = await realpath(source);
      if (!inside(await realpath(containment), root)) throw new GenerationOutputError("output_unsafe", "The export output leaves its allowed directory.");
      const entry = await lstat(join(root, "index.html")).catch(() => null);
      if (!entry?.isFile()) throw new GenerationOutputError("output_entry_missing", "The export output has no index.html.");
      await mkdir(target, { mode: 0o700 });
      const copy = async (from: string, to: string, depth: number): Promise<void> => {
        if (depth > this.limits.maxDepth) throw new GenerationOutputError("output_limit", "The export output is nested too deeply.");
        for (const item of await readdir(from, { withFileTypes: true })) {
          // Export provenance is private; Godot's runtime does not require this manifest.
          if (depth === 0 && item.name === "build.json") { skipped += 1; continue; }
          if (!SERVED_SEGMENT.test(item.name)) { skipped += 1; continue; }
          const sourcePath = join(from, item.name), targetPath = join(to, item.name);
          if (item.isDirectory()) { await mkdir(targetPath, { mode: 0o700 }); await copy(sourcePath, targetPath, depth + 1); continue; }
          if (!item.isFile() || !SERVED_EXTENSIONS.has(extname(item.name).toLowerCase())) { skipped += 1; continue; }
          if (++files > this.limits.maxFiles) throw new GenerationOutputError("output_limit", "The export output has too many files.");
          const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
          if (!handle) { skipped += 1; files -= 1; continue; }
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) { skipped += 1; files -= 1; continue; }
            bytes += stat.size;
            if (bytes > this.limits.maxBytes) throw new GenerationOutputError("output_limit", "The export output exceeds the size limit.");
            await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
          } finally { await handle.close(); }
        }
      };
      await copy(root, target, 0);
      await writeFile(join(target, ".worktree-key"), worktreeKey, { mode: 0o600 });
      const generation: GenerationMeta = { ...meta, id, publishedAt: new Date().toISOString(), files, bytes };
      // A runtime stopped or switched during the copy must not repoint the served build.
      if (!await current()) throw new GenerationSupersededError();
      await rename(target, join(this.generations, id));
      await atomicJson(join(this.meta, `${id}.json`), generation);
      if (!await current()) { await rm(join(this.generations, id), { recursive: true, force: true }); await rm(join(this.meta, `${id}.json`), { force: true }); throw new GenerationSupersededError(); }
      await this.writeState({ generation: id, worktreeKey, publishedAt: generation.publishedAt, build: "idle", failureCode: null });
      await this.prune(id);
      return { generation, skipped };
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  /** Keeps the current generation plus the most recent retained predecessors. */
  async prune(current: string | null): Promise<void> {
    const ids = (await readdir(this.generations).catch(() => [] as string[])).filter((id) => GENERATION_ID.test(id)).sort().reverse();
    const keep = new Set([...(current ? [current] : []), ...ids.filter((id) => id !== current).slice(0, Math.max(0, this.limits.retain - (current ? 1 : 0)))]);
    for (const id of ids) {
      if (keep.has(id)) continue;
      await rm(join(this.generations, id), { recursive: true, force: true });
      await rm(join(this.meta, `${id}.json`), { force: true });
    }
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
