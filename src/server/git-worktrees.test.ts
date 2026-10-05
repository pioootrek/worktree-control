import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitCommandAdmission, parseWorktreePorcelain, SystemGitWorktreeReader } from "./git-worktrees";

describe("parseWorktreePorcelain", () => {
  it("reports commit dates and merged branches against main, without classifying main as merged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "switcher-insights-"));
    const reader = new SystemGitWorktreeReader();
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
    try {
      git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
      git("commit", "--allow-empty", "-m", "initial");
      git("worktree", "add", "-b", "finished", join(directory, "finished"));
      const rows = await reader.list(directory, { includeInsights: true });
      expect(rows.find((w) => w.branch === "main")).toMatchObject({ isDefaultBranch: true, merged: false, mergedInto: "main" });
      expect(rows.find((w) => w.branch === "finished")).toMatchObject({ merged: true, mergedInto: "main", lastCommitAt: expect.any(String) });
      execFileSync("git", ["-C", join(directory, "finished"), "commit", "--allow-empty", "-m", "new work"], { stdio: "pipe" });
      expect((await reader.list(directory, { includeInsights: true })).find((w) => w.branch === "finished")?.merged).toBe(false);
    } finally { reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("parses branches, detached worktrees, and flags from nul-delimited output", () => {
    const output = [
      "worktree /code/app",
      "HEAD 0123456789abcdef",
      "branch refs/heads/main",
      "",
      "worktree /code/app-feature",
      "HEAD fedcba9876543210",
      "detached",
      "locked maintenance",
      "",
    ].join("\0");

    expect(parseWorktreePorcelain(output)).toEqual([
      {
        path: "/code/app",
        head: "0123456789abcdef",
        shortHead: "01234567",
        branch: "main",
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/code/app-feature",
        head: "fedcba9876543210",
        shortHead: "fedcba98",
        branch: null,
        detached: true,
        locked: true,
        prunable: false,
      },
    ]);
  });
});

describe("GitCommandAdmission", () => {
  it("bounds execution and admits operational validation before queued display work", async () => {
    const admission = new GitCommandAdmission(1, 1);
    const order: string[] = [];
    let release!: () => void;
    const first = admission.run("background", async () => {
      order.push("background-running");
      await new Promise<void>((resolve) => { release = resolve; });
      return "first";
    });
    const second = admission.run("background", async () => { order.push("background-queued"); return "second"; });
    const operational = admission.run("operational", async () => { order.push("operational"); return "operational"; });
    release();
    await expect(first).resolves.toBe("first");
    await expect(operational).resolves.toBe("operational");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["background-running", "operational", "background-queued"]);
    admission.close();
  });

  it("rejects excess queued work and aborts an owned command on close", async () => {
    const admission = new GitCommandAdmission(1, 1);
    const running = admission.run("background", (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const queued = admission.run("background", async () => undefined);
    await expect(admission.run("background", async () => undefined)).rejects.toThrow("Kolejka poleceń Git");
    admission.close();
    await expect(running).rejects.toThrow("aborted");
    await expect(queued).rejects.toThrow("zamknięta");
  });

  it("reserves capacity for local operations while serializing remote fetches", async () => {
    const admission = new GitCommandAdmission(2, 2, 1);
    const order: string[] = [];
    let releaseRemote!: () => void;
    const firstRemote = admission.run("remote", async () => {
      order.push("remote-running");
      await new Promise<void>((resolve) => { releaseRemote = resolve; });
    });
    const secondRemote = admission.run("remote", async () => { order.push("remote-queued"); });
    const operational = admission.run("operational", async () => { order.push("operational"); });

    await operational;
    expect(order).toEqual(["remote-running", "operational"]);
    releaseRemote();
    await Promise.all([firstRemote, secondRemote]);
    expect(order).toEqual(["remote-running", "operational", "remote-queued"]);
    admission.close();
  });
});

describe("SystemGitWorktreeReader.observe", () => {
  it("records bounded clean and dirty status evidence without paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-source-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", directory]);
      execFileSync("git", ["-C", directory, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", directory, "config", "user.name", "Test"]);
      writeFileSync(join(directory, "tracked.txt"), "one\n");
      execFileSync("git", ["-C", directory, "add", "tracked.txt"]);
      execFileSync("git", ["-C", directory, "commit", "-qm", "fixture"]);
      const reader = new SystemGitWorktreeReader();
      const clean = await reader.observe(directory);
      writeFileSync(join(directory, "tracked.txt"), "two\n");
      writeFileSync(join(directory, "untracked.txt"), "new\n");
      const dirty = await reader.observe(directory);
      expect(clean).toMatchObject({ branch: "main", dirty: false, statusEntries: 0, complete: true, errorCode: null });
      expect(dirty).toMatchObject({ head: clean.head, branch: "main", dirty: true, statusEntries: 2, complete: true, errorCode: null });
      expect(dirty.statusDigest).not.toBe(clean.statusDigest);
      expect(JSON.stringify(dirty)).not.toContain("tracked.txt");
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
