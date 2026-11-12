import { randomUUID } from "node:crypto";

import { AdminRequestError, requestAdminSocket } from "../server/admin-socket";
import { TEST_RUN_ADMIN_COMMAND, TEST_RUN_ADMIN_MAX_WAIT_MS } from "../server/bootstrap/test-run-administration";

export const TEST_RUN_USAGE = [
  "Usage: worktree-control test-run inspect <run-id> [--project PROJECT_ID]",
  "       worktree-control test-run stop <run-id> --reason TEXT [--project PROJECT_ID] [--wait-seconds N] [--request-id KEY]",
].join("\n");

const DEFAULT_WAIT_SECONDS = 30;
/** Inspection carries bounded fields and at most ten audit records. */
const RESPONSE_LIMIT_BYTES = 128 * 1024;
/** Socket transport margin on top of the server's bounded wait and the owner's decision floor. */
const TRANSPORT_MARGIN_MS = 20_000;

/** Exit codes: 0 confirmed (or found for inspect), 2 pending, 3 unresolved or not found. */
export const TEST_RUN_EXIT = { confirmed: 0, pending: 2, unresolved: 3 } as const;

export interface TestRunCommandDependencies {
  write(line: string): void;
  request?: typeof requestAdminSocket;
  requestId?: () => string;
}

type Parsed =
  | { action: "inspect"; runId: string; projectId?: string }
  | { action: "stop"; runId: string; projectId?: string; reason: string; waitSeconds: number; requestId?: string };

export function parseTestRunArgs(args: readonly string[]): Parsed {
  const usage = () => new Error(TEST_RUN_USAGE);
  const [action, runId, ...rest] = args;
  if ((action !== "inspect" && action !== "stop") || !runId || runId.startsWith("-")) throw usage();
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    const allowed = action === "inspect" ? ["--project"] : ["--project", "--reason", "--wait-seconds", "--request-id"];
    if (!allowed.includes(name) || value === undefined || value.startsWith("--") || options.has(name)) throw usage();
    options.set(name, value);
  }
  const projectId = options.get("--project");
  if (action === "inspect") return { action, runId, ...(projectId ? { projectId } : {}) };
  const reason = options.get("--reason");
  if (!reason?.trim()) throw new Error(`test-run stop requires --reason TEXT (3-200 characters, no secrets).\n${TEST_RUN_USAGE}`);
  const waitText = options.get("--wait-seconds") ?? String(DEFAULT_WAIT_SECONDS);
  const waitSeconds = Number(waitText);
  if (!/^\d+$/.test(waitText) || waitSeconds * 1000 > TEST_RUN_ADMIN_MAX_WAIT_MS) {
    throw new Error(`--wait-seconds must be an integer from 0 to ${TEST_RUN_ADMIN_MAX_WAIT_MS / 1000}.`);
  }
  const requestId = options.get("--request-id");
  return { action, runId, reason, waitSeconds, ...(projectId ? { projectId } : {}), ...(requestId ? { requestId } : {}) };
}

/**
 * Local operator command for one exact test run. It only talks to the running
 * controller over the owner-only admin socket and fails closed when that socket
 * is unavailable: it never opens the database or a second store instance, and it
 * never signals a process itself.
 */
export async function runTestRunCommand(args: readonly string[], socketPath: string, dependencies: TestRunCommandDependencies): Promise<number> {
  const parsed = parseTestRunArgs(args);
  const request = dependencies.request ?? requestAdminSocket;
  const body = parsed.action === "inspect"
    ? { command: TEST_RUN_ADMIN_COMMAND, action: "inspect", runId: parsed.runId, ...(parsed.projectId ? { projectId: parsed.projectId } : {}) }
    : {
      command: TEST_RUN_ADMIN_COMMAND, action: "stop", runId: parsed.runId, reason: parsed.reason,
      waitMs: parsed.waitSeconds * 1000,
      requestId: parsed.requestId ?? (dependencies.requestId ?? (() => `cli-${randomUUID()}`))(),
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    };
  const timeoutMs = (parsed.action === "stop" ? parsed.waitSeconds * 1000 : 0) + TRANSPORT_MARGIN_MS;
  let result: unknown;
  try {
    result = await request(socketPath, body, timeoutMs, RESPONSE_LIMIT_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK") {
      throw Object.assign(new Error(`controller_unavailable: no running controller answered on the owner-only admin socket at ${socketPath}. Nothing was changed. This command never opens the database directly; start the controller or inspect the host manually.`), { code: "controller_unavailable" });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw Object.assign(new Error(`admin_socket_denied: the admin socket at ${socketPath} belongs to another OS account. Run this command as the controller's user.`), { code: "admin_socket_denied" });
    }
    if (code === "admin_timeout") {
      throw Object.assign(new Error(`admin_timeout: the controller did not answer within ${Math.round(timeoutMs / 1000)} s. The request may still be applied; re-check with 'worktree-control test-run inspect ${parsed.runId}'.`), { code: "admin_timeout" });
    }
    if (error instanceof AdminRequestError) throw Object.assign(new Error(`${error.code ?? "admin_request_failed"}: ${error.message}`), { code: error.code });
    throw error;
  }
  dependencies.write(JSON.stringify(result, null, 2));
  if (parsed.action === "inspect") {
    return (result as { found?: unknown } | null)?.found === true ? 0 : TEST_RUN_EXIT.unresolved;
  }
  const outcome = (result as { outcome?: unknown } | null)?.outcome;
  return outcome === "confirmed" ? TEST_RUN_EXIT.confirmed : outcome === "pending" ? TEST_RUN_EXIT.pending : TEST_RUN_EXIT.unresolved;
}
