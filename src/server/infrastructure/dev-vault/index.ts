import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { DevVaultError, type DevVaultKeyProvider } from "@/server/modules/dev-vault";

/** Explicit external files only. No creation, chmod, fallback, or host-key discovery. */
export function readExternalVaultFile(path: string | undefined, excludedRoots: readonly string[], secret: boolean, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    if (!path || !isAbsolute(path)) throw new Error();
    const canonical = realpathSync(path);
    for (const root of excludedRoots) {
      const inside = relative(resolve(root), canonical);
      if (!inside || (!inside.startsWith("../") && inside !== ".." && !isAbsolute(inside))) throw new Error();
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
