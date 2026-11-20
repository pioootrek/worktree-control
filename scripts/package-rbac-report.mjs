import { AssertionError } from "node:assert";

const npmCodes = new Set(["E404", "E401", "E403", "EACCES", "ECONNRESET", "EINTEGRITY", "ENOSPC", "ERESOLVE", "ETIMEDOUT"]);

export function failureReport(baseline, steps, error) {
  // Nested steps record their outcome before control returns to the enclosing step.
  const failureStep = steps.find(step => !step.ok)?.name;
  const report = { result: "failed", baseline, failureStep, steps, error: acceptanceError(error) };
  if (typeof error?.stderr === "string") {
    const code = /^npm error code (\S+)\r?$/m.exec(error.stderr)?.[1];
    if (npmCodes.has(code)) report.npmErrorCode = code;
  }
  return report;
}

// Error messages can contain command arguments, provider responses or assertion diffs.
export function acceptanceError(error) {
  if (error instanceof Error && ("cmd" in error || "stderr" in error || "stdout" in error)) {
    return "Subprocess failed";
  }
  if (error instanceof AssertionError) return "AssertionError: acceptance check failed";
  if (error instanceof SyntaxError) return "SyntaxError: invalid input";
  if (error instanceof TypeError) return "TypeError: acceptance step failed";
  if (error instanceof Error && error.message === "Finite fixture condition timed out.") {
    return "Finite fixture condition timed out.";
  }
  return "Acceptance step failed";
}
