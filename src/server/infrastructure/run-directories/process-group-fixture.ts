import { spawn, type ChildProcess } from "node:child_process";

/** Whether no process of `groupId` exists any more, by the same zero-signal probe the sweep uses. */
export function groupGone(groupId: number): boolean {
  try { process.kill(-groupId, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  // Node emits `exit` after the child has been reaped, so its pid no longer names a process.
  return new Promise(resolve => child.once("exit", () => resolve()));
}

/**
 * Real detached process groups for tests. Each child is the leader of its own
 * group, so its pid is the group id the controller records. `stopAll` kills
 * every group a test created and waits until it is gone.
 */
export class ProcessGroups {
  private readonly children: ChildProcess[] = [];

  /** A group whose only process keeps running until the test stops it. */
  async live(): Promise<number> {
    const child = this.spawn("setInterval(() => {}, 1000);");
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    return child.pid!;
  }

  /** The id of a group whose only process has exited and been reaped. */
  async exited(): Promise<number> {
    const child = this.spawn("");
    await exited(child);
    return child.pid!;
  }

  async stop(groupId: number): Promise<void> {
    const child = this.children.find(candidate => candidate.pid === groupId);
    if (!child) throw new Error(`not a group of this test: ${groupId}`);
    await this.kill(child);
  }

  /** Stops every group and returns the ids of those still present afterwards (expected: none). */
  async stopAll(): Promise<number[]> {
    const children = this.children.splice(0);
    await Promise.all(children.map(child => this.kill(child)));
    return children.map(child => child.pid!).filter(groupId => !groupGone(groupId));
  }

  private spawn(script: string): ChildProcess {
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    this.children.push(child);
    return child;
  }

  private async kill(child: ChildProcess): Promise<void> {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await exited(child);
  }
}
