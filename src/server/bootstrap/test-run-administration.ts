import type { TestRunAdministration } from "../modules/verification";

export interface TestRunAdministrationHandlerDependencies {
  administration: Pick<TestRunAdministration, "inspect" | "stop">;
  maintenance(): boolean;
}

export const TEST_RUN_ADMIN_COMMAND = "test-run-admin";
export const TEST_RUN_ADMIN_MAX_WAIT_MS = 120_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export class TestRunAdminRequestError extends Error {
  readonly code = "invalid_input";
  constructor() { super("Invalid test run administration request."); this.name = "TestRunAdminRequestError"; }
}

type ParsedRequest =
  | { action: "inspect"; runId: string; projectId?: string }
  | { action: "stop"; runId: string; projectId?: string; reason: string; waitMs: number; requestId: string };

/**
 * Exact-run inspection and stop over the owner-only admin socket. Operating-system
 * permissions on the socket are the administrator credential, independent of the
 * public open/token/account mode. The request carries no actor, session or
 * credential field: nothing in it can claim another requester's identity.
 */
export function testRunAdminHandler(dependencies: TestRunAdministrationHandlerDependencies) {
  return async (body: unknown): Promise<unknown> => {
    const request = parseTestRunAdminRequest(body);
    if (dependencies.maintenance()) throw Object.assign(new Error("Controller is in maintenance."), { code: "maintenance" });
    if (request.action === "inspect") return dependencies.administration.inspect({ runId: request.runId, ...(request.projectId ? { projectId: request.projectId } : {}) });
    return dependencies.administration.stop({
      runId: request.runId, reason: request.reason, waitMs: request.waitMs, requestId: request.requestId,
      ...(request.projectId ? { projectId: request.projectId } : {}),
    });
  };
}

export function parseTestRunAdminRequest(body: unknown): ParsedRequest {
  const invalid = () => new TestRunAdminRequestError();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const record = body as Record<string, unknown>;
  if (record.command !== TEST_RUN_ADMIN_COMMAND) throw invalid();
  const keys = Object.keys(record).filter(key => key !== "projectId").sort().join(",");
  const projectId = "projectId" in record ? identifier(record.projectId, 200, invalid) : undefined;
  const runId = identifier(record.runId, 128, invalid);
  if (record.action === "inspect") {
    if (keys !== "action,command,runId") throw invalid();
    return { action: "inspect", runId, ...(projectId ? { projectId } : {}) };
  }
  if (record.action === "stop") {
    if (keys !== "action,command,reason,requestId,runId,waitMs") throw invalid();
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200 || CONTROL.test(reason)) throw invalid();
    if (typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId)) throw invalid();
    const waitMs = record.waitMs;
    if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > TEST_RUN_ADMIN_MAX_WAIT_MS) throw invalid();
    return { action: "stop", runId, reason, waitMs, requestId: record.requestId, ...(projectId ? { projectId } : {}) };
  }
  throw invalid();
}

function identifier(value: unknown, limit: number, invalid: () => Error): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || !IDENTIFIER.test(value)) throw invalid();
  return value;
}
