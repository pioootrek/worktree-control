import { spawn, type ChildProcess } from "node:child_process";
import { OwnedProcessGroup } from "@/server/owned-process-group";

export class PreparationError extends Error {
  constructor(readonly code: string, readonly cleanupUnconfirmed = false, readonly exitCode: number | null = null) { super(code); }
}

export interface PreparationCommand {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  errorCode: string;
}
export interface VerificationPreparationContext {
  readonly signal: AbortSignal;
  throwIfAborted(): void;
  /** Only for waiting on inert work, such as admission. The operation must check signal before effects. */
  wait<T>(pending: Promise<T>): Promise<T>;
  command(input: PreparationCommand): Promise<string>;
}

/** The finite queue owns this session. It adds no scheduler or capacity authority. */
export class PreparationSession implements VerificationPreparationContext {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly groups = new Set<OwnedProcessGroup>();
  readonly signal = this.controller.signal;
  cleanupUnconfirmed = false;
  constructor(timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) throw new PreparationError("invalid_preparation_timeout");
    this.timer = setTimeout(() => this.controller.abort(new PreparationError("preparation_timeout")), timeoutMs);
    this.timer.unref();
  }
  cancel(): void { this.controller.abort(new PreparationError("preparation_cancelled")); }
  close(): void { clearTimeout(this.timer); }
  throwIfAborted(): void { this.signal.throwIfAborted(); }
  wait<T>(pending: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
      void pending.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", abort));
    });
  }
  async command(input: PreparationCommand): Promise<string> {
    this.throwIfAborted();
    const signal = AbortSignal.any([this.signal, ...(input.signal ? [input.signal] : []), ...(input.timeoutMs ? [AbortSignal.timeout(input.timeoutMs)] : [])]);
    signal.throwIfAborted();
    let child: ChildProcess;
    try {
      child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.environment as NodeJS.ProcessEnv,
        detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch { throw new PreparationError(input.errorCode); }
    const group = new OwnedProcessGroup(child);
    this.groups.add(group);
    let output = "", bytes = 0, overflow = false;
    const limit = input.maxOutputBytes ?? 2 * 1024 * 1024;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (limit === 0) return; // Drain without retaining or publishing setup output.
      bytes += chunk.length;
      if (bytes <= limit) output += chunk.toString("utf8");
      else { overflow = true; wake(); }
    });
    let wake = () => undefined as void;
    let failed = false;
    const exit = new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.once("error", () => { failed = true; resolve(); });
    });
    const stop = new Promise<void>(resolve => { wake = resolve; });
    const abort = () => wake();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) wake();
    try {
      await Promise.race([exit, stop]);
      // Launcher exit is insufficient: pnpm/Git helpers may still own descendants.
      await group.stop();
      let exitTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exit, new Promise<never>((_resolve, reject) => {
          exitTimer = setTimeout(() => reject(new Error("Owned launcher exit unconfirmed")), 1_000);
          exitTimer.unref();
        })]);
      } finally { if (exitTimer) clearTimeout(exitTimer); }
      this.groups.delete(group);
    } catch {
      this.cleanupUnconfirmed = true;
      throw new PreparationError("preparation_cleanup_unconfirmed", true);
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdout?.destroy();
    }
    this.throwIfAborted();
    if (signal.aborted || failed || overflow || child.exitCode !== 0) throw new PreparationError(input.errorCode, false, child.exitCode);
    return output;
  }
}
