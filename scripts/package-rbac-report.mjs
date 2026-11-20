/** Redact before bounding, so truncation cannot expose a prefix of a secret. */
export function acceptanceError(error, secretValues, temporaryRoots) {
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  let message = `${kind}: ${error instanceof Error ? error.message : String(error)}`;
  const privateValues = [...secretValues, ...temporaryRoots].filter(value => typeof value === "string" && value.length > 0);
  for (const value of privateValues.sort((a, b) => b.length - a.length)) message = message.replaceAll(value, "[redacted]");
  return message.slice(0, 300);
}
