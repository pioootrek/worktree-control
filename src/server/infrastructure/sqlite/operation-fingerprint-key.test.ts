import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintKeyId } from "@/server/modules/operations";
import { loadOperationKey, OPERATION_KEY_BYTES, OperationKeyError, operationKeyPath } from "./operation-fingerprint-key";

/** D6: the fingerprint key file beside the canonical database path, through the private-storage validators. */
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) { try { chmodSync(root, 0o700); } catch { /* removed */ } rmSync(root, { recursive: true, force: true }); }
});
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "operation-key-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  return data;
}
const failure = (call: () => unknown) => { try { call(); } catch (error) { return error instanceof OperationKeyError ? error.reason : `other: ${(error as Error).message}`; } return "accepted"; };

describe("the operation fingerprint key file", () => {
  it("is created once with mode 0600 and 32 bytes, read back unchanged, and identified by its generation only", () => {
    const database = join(directory(), "state.sqlite3");
    const key = loadOperationKey(database);
    expect(key).toHaveLength(OPERATION_KEY_BYTES);
    const stat = lstatSync(operationKeyPath(database));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(loadOperationKey(database).equals(key)).toBe(true);
    expect(fingerprintKeyId(key)).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprintKeyId(key)).not.toContain(key.toString("hex").slice(0, 16));
    expect(readdirSync(join(database, "..")).sort()).toEqual(["state.sqlite3.operation-key"]);
  });

  it("binds the key to the database file: two databases in one directory have independent keys", () => {
    const data = directory();
    const first = loadOperationKey(join(data, "a.sqlite3")), second = loadOperationKey(join(data, "b.sqlite3"));
    expect(first.equals(second)).toBe(false);
    expect(fingerprintKeyId(first)).not.toBe(fingerprintKeyId(second));
  });

  it("recovers an interrupted creation: a leftover temporary is removed, also one still linked to the published key", () => {
    const data = directory(), database = join(data, "state.sqlite3");
    const temporary = join(data, "state.sqlite3.operation-key.tmp-00000000-0000-4000-8000-000000000000");
    writeFileSync(temporary, Buffer.alloc(5), { mode: 0o600 });
    const key = loadOperationKey(database);
    expect(readdirSync(data)).toEqual(["state.sqlite3.operation-key"]);
    // A crash between the no-replace link and the unlink leaves two links to the published key.
    linkSync(operationKeyPath(database), temporary);
    expect(lstatSync(operationKeyPath(database)).nlink).toBe(2);
    expect(loadOperationKey(database).equals(key)).toBe(true);
    expect(lstatSync(operationKeyPath(database)).nlink).toBe(1);
  });

  it("never overwrites a published file of the wrong size", () => {
    for (const size of [0, 5, 31, 33, 64]) {
      const database = join(directory(), "state.sqlite3");
      writeFileSync(operationKeyPath(database), Buffer.alloc(size, 1), { mode: 0o600 });
      expect(failure(() => loadOperationKey(database)), String(size)).toMatch(/^key_(malformed|unsafe)$/);
      expect(readFileSync(operationKeyPath(database))).toEqual(Buffer.alloc(size, 1));
    }
  });

  it("refuses a wrong mode, a symlink, a hardlink, another owner and a key inside an excluded tree", () => {
    const wrongMode = join(directory(), "state.sqlite3");
    loadOperationKey(wrongMode);
    for (const mode of [0o640, 0o400, 0o644, 0o700]) {
      chmodSync(operationKeyPath(wrongMode), mode);
      expect(failure(() => loadOperationKey(wrongMode)), mode.toString(8)).toBe("key_unsafe");
    }
    const symlinked = join(directory(), "state.sqlite3");
    const target = join(directory(), "elsewhere");
    writeFileSync(target, Buffer.alloc(32, 2), { mode: 0o600 });
    symlinkSync(target, operationKeyPath(symlinked));
    expect(failure(() => loadOperationKey(symlinked))).toBe("key_unsafe");
    const hardlinked = join(directory(), "state.sqlite3");
    const other = join(directory(), "other");
    writeFileSync(other, Buffer.alloc(32, 3), { mode: 0o600 });
    linkSync(other, operationKeyPath(hardlinked));
    expect(failure(() => loadOperationKey(hardlinked))).toBe("key_unsafe");
    const foreign = join(directory(), "state.sqlite3");
    loadOperationKey(foreign);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(failure(() => loadOperationKey(foreign))).toBe("key_unsafe");
    vi.restoreAllMocks();
    const data = directory();
    expect(failure(() => loadOperationKey(join(data, "state.sqlite3"), [data]))).toBe("key_unsafe");
  });

  it("refuses a database directory that is not private, without creating anything", () => {
    const data = directory();
    chmodSync(data, 0o755);
    expect(failure(() => loadOperationKey(join(data, "state.sqlite3")))).toMatch(/^key_(unsafe|create_failed)$/);
    expect(readdirSync(data)).toEqual([]);
  });
});
