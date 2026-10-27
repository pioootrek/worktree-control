import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DROP_IN_LIMITS, inspectSystemdDropIns, matchesSystemdDropInPaths, sameSystemdPolicy } from "./systemd-drop-ins";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const homes: string[] = [];
const unit = "worktree-control.service";
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(join(tmpdir(), 'drop-ins "quoted"-')); homes.push(home);
  const roots = [join(home, "user"), join(home, "runtime"), join(home, "vendor")];
  function put(root: number, scope: string, name: string, content = "[Service]\nMemoryMax=512M\n") {
    const directory = join(roots[root], `${scope}.d`); fs.mkdirSync(directory, { recursive: true });
    const path = join(directory, name); fs.writeFileSync(path, content); return path;
  }
  return { home, roots, put, inspect: () => inspectSystemdDropIns(roots, unit) };
}

describe("bounded systemd effective drop-in inspection", () => {
  it("uses root precedence before named specificity, then all type scopes, and sorts by filename bytes", () => {
    const { roots, put, inspect } = fixture();
    const prefix = put(0, "worktree-.service", "50-shared.conf", "[Service]\nMemoryMax=1G\n");
    put(2, unit, "50-shared.conf", "[Service]\nExecStart=/ignored\n");
    const named = put(2, unit, "20-named.conf", "[Service]\nTasksMax=64\n");
    put(0, "service", "20-named.conf", "[Service]\nEnvironment=ignored\n");
    const upper = put(2, "service", "Z.conf", "[Service]\nCPUQuota=50%\n");
    const lower = put(1, "service", "a.conf", "[Service]\nCPUQuota=60%\n");
    expect(inspect().files.map(file => file.path)).toEqual([named, prefix, upper, lower]);
    expect(inspect().assignments).toEqual([["TasksMax", "64"], ["MemoryMax", "1G"], ["CPUQuota", "50%"], ["CPUQuota", "60%"]]);
    expect(() => inspectSystemdDropIns([...roots].reverse(), unit)).toThrow("Inspect and reconcile");
  });

  it("prefers the specific named directory within a root", () => {
    const { put, inspect } = fixture();
    const specific = put(0, unit, "limits.conf");
    put(0, "worktree-.service", "limits.conf", "[Service]\nKillMode=process\n");
    expect(inspect().files.map(file => file.path)).toEqual([specific]);
  });

  it("retains /dev/null masks and empty winners in the selected list without reading shadowed content", () => {
    const { put, inspect } = fixture();
    const mask = put(0, unit, "10-mask.conf", ""); fs.rmSync(mask); fs.symlinkSync("/dev/null", mask);
    const empty = put(0, "worktree-.service", "20-empty.conf", "");
    put(2, "service", "10-mask.conf", "[Service]\nExecStart=/ignored\n");
    put(2, unit, "20-empty.conf", "[Service]\nEnvironment=ignored\n");
    const policy = inspect();
    expect(policy.assignments).toEqual([]);
    expect(policy.files.map(file => [file.path, file.mask])).toEqual([[mask, true], [empty, false]]);
    expect(matchesSystemdDropInPaths(policy, [mask, empty])).toBe(true);
    expect(matchesSystemdDropInPaths(policy, [empty, mask])).toBe(false);
    expect(matchesSystemdDropInPaths(policy, [mask])).toBe(false);
  });

  it("keeps resets and repeated assignments in order, instead of treating them as last-wins", () => {
    const { roots, put, inspect } = fixture();
    put(0, unit, "limits.conf", "[Service]\nIOReadBandwidthMax=/dev/sda 1M\nIOReadBandwidthMax=\nIOReadBandwidthMax=/dev/sdb 2M\n");
    const before = inspect();
    expect(before.assignments).toEqual([["IOReadBandwidthMax", "/dev/sda 1M"], ["IOReadBandwidthMax", ""], ["IOReadBandwidthMax", "/dev/sdb 2M"]]);
    put(0, unit, "limits.conf", "[Service]\nIOReadBandwidthMax=/dev/sdb 2M\n");
    expect(sameSystemdPolicy(before, inspectSystemdDropIns(roots, unit))).toBe(false);
  });

  it.each(["ExecStart=/evil", "Environment=BAD=1", "KillMode=process", "TimeoutStopFailureMode=abort", "UnknownPolicy=yes", "MemoryMax=%n", "MemoryMax=$VALUE", "MemoryMax=1G\\\nExecStart=/evil", "[Unit]\nDescription=override", "[Unknown]", "MemoryMax=1G\0"])("refuses unsupported content: %s", directive => {
    const { put, inspect } = fixture(); put(0, "service", "policy.conf", `[Service]\n${directive}\n`);
    expect(inspect).toThrow("Inspect and reconcile");
  });

  it.each(["symlink", "fifo", "directory", "unreadable", "invalid UTF-8", "BOM", "oversize"])("refuses %s without unbounded reads", kind => {
    const { put, inspect } = fixture();
    const path = put(0, "service", "policy.conf");
    if (kind === "symlink") { fs.rmSync(path); fs.symlinkSync("/etc/passwd", path); }
    if (kind === "fifo") { fs.rmSync(path); execFileSync("mkfifo", [path]); }
    if (kind === "directory") { fs.rmSync(path); fs.mkdirSync(path); }
    if (kind === "unreadable") vi.spyOn(fs, "openSync").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    if (kind === "invalid UTF-8") fs.writeFileSync(path, Buffer.from([0xff]));
    if (kind === "BOM") fs.writeFileSync(path, "\uFEFF[Service]\nMemoryMax=1G\n");
    if (kind === "oversize") fs.truncateSync(path, DROP_IN_LIMITS.bytes + 1);
    expect(inspect).toThrow("Inspect and reconcile");
  });

  it("refuses symlinked directories and unreadable directory scans", () => {
    const { roots, put, inspect } = fixture();
    const path = put(0, unit, "limits.conf");
    fs.renameSync(join(roots[0], `${unit}.d`), join(roots[0], "real"));
    fs.symlinkSync(join(roots[0], "real"), join(roots[0], `${unit}.d`));
    expect(inspect).toThrow("Inspect and reconcile");
    fs.rmSync(join(roots[0], `${unit}.d`)); fs.renameSync(join(roots[0], "real"), join(roots[0], `${unit}.d`));
    expect(fs.existsSync(path)).toBe(true);
    vi.spyOn(fs, "opendirSync").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    expect(inspect).toThrow("Inspect and reconcile");
  });

  it.each(["files", "entries", "bytes", "roots"] as const)("enforces the aggregate %s bound", limit => {
    const { roots, put, inspect } = fixture();
    if (limit === "files") for (let index = 0; index <= DROP_IN_LIMITS.files; index++) put(index % roots.length, "service", `${index}.conf`, "");
    if (limit === "entries") for (let index = 0; index <= DROP_IN_LIMITS.entries; index++) put(0, unit, `${index}.ignored`, "");
    if (limit === "bytes") { fs.truncateSync(put(0, unit, "a.conf", "#"), DROP_IN_LIMITS.bytes); put(1, "service", "b.conf", "#"); }
    if (limit === "roots") { expect(() => inspectSystemdDropIns(Array.from({ length: DROP_IN_LIMITS.roots + 1 }, (_, index) => `/fixture/${index}`), unit)).toThrow("Inspect and reconcile"); return; }
    expect(inspect).toThrow("Inspect and reconcile");
  });
});
