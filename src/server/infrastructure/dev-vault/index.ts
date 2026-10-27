import { constants, openSync, closeSync, existsSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { DevVaultError, type DevVaultKeyProvider } from "@/server/modules/dev-vault";

/** Explicit external files only. No creation, chmod, fallback, or host-key discovery. */
export function readExternalVaultFile(path: string | undefined, excludedRoots: readonly string[], secret: boolean, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    if (!path || !isAbsolute(path)) throw new Error();
    const canonical = realpathSync(path);
    for (const root of excludedRoots) {
      const inside = relative(realpathSync(root), canonical);
      if (!inside || (!inside.startsWith("../") && inside !== ".." && !isAbsolute(inside))) throw new Error();
    }
    if (secret) {
      // Secret key files cannot live in a Git working tree, even if currently ignored.
      let parent = dirname(canonical), visited = 0;
      for (;;) {
        if (++visited > 128 || existsSync(join(parent, ".git"))) throw new Error();
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || (stat.mode & (secret ? 0o077 : 0o022)) !== 0) throw new Error();
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error();
    return bytes;
  } catch { throw new DevVaultError("vault_unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class ExternalFileDevVaultKeyProvider implements DevVaultKeyProvider {
  private pinned: Buffer | undefined;
  constructor(private readonly path: string | undefined, private readonly excludedRoots: readonly string[]) {}
  key(): Buffer {
    const key = readExternalVaultFile(this.path, this.excludedRoots, true, 32);
    if (key.length !== 32 || (this.pinned && !timingSafeEqual(this.pinned, key))) throw new DevVaultError("vault_unavailable");
    this.pinned ??= key;
    return key;
  }
}
