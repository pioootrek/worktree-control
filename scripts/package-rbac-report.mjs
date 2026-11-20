export function failureReport(baseline, steps, error) {
  // Nested steps record their outcome before control returns to the enclosing step.
  const failureStep = steps.find(step => !step.ok)?.name;
  return { result: "failed", baseline, failureStep, steps, error };
}

/** Redact before bounding, so truncation cannot expose a prefix of a secret. */
export function acceptanceError(error, secretValues, temporaryRoots) {
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  let message = `${kind}: ${error instanceof Error ? error.message : String(error)}`;
  const privateValues = [...secretValues, ...temporaryRoots].filter(value => typeof value === "string" && value.length > 0);
  for (const value of privateValues.sort((a, b) => b.length - a.length)) message = message.replaceAll(value, "[redacted]");
  return message.slice(0, 300);
}
