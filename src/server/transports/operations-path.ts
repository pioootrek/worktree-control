/** Claim on the raw target, before URL normalization or any legacy dispatch. */
export function parseOperationsPath(target: string, ids: readonly string[]):
  { claimed: false } | { claimed: true; operation: string | null; surface: "api" | "mcp" } {
  const claims = (namespace: string) => target.startsWith(namespace) && (target.length === namespace.length || "/?%\\#".includes(target[namespace.length]));
  const surface = claims("/api/operations") ? "api" : claims("/mcp/operations") ? "mcp" : null;
  if (!surface) return { claimed: false };
  if (surface === "mcp") return { claimed: true, operation: null, surface };
  const id = target.slice("/api/operations/".length);
  return { claimed: true, surface, operation: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) && ids.includes(id) ? id : null };
}
