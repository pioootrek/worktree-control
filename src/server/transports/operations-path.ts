/** Claim on the raw target, before URL normalization or any legacy dispatch. */
export function parseOperationsPath(target: string, ids: readonly string[]):
  { claimed: false } | { claimed: true; operation: string | null; surface: "api" | "mcp" } {
  const surface = target.startsWith("/api/operations/") || target === "/api/operations" || target.startsWith("/api/operations?") ? "api"
    : target === "/mcp/operations" || target.startsWith("/mcp/operations/") || target.startsWith("/mcp/operations?") ? "mcp" : null;
  if (!surface) return { claimed: false };
  if (surface === "mcp") return { claimed: true, operation: null, surface };
  const id = target.slice("/api/operations/".length);
  return { claimed: true, surface, operation: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) && ids.includes(id) ? id : null };
}
