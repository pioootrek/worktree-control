/** Claim on the raw target, before URL normalization or any legacy dispatch. */
export function parseOperationsPath(target: string, ids: readonly string[]):
  { claimed: false } | { claimed: true; operation: string | null; surface: "api" | "mcp" } {
  const surface = claimedSurface(target);
  if (!surface) {
    // Refusal only: never turn an alias into an executable operation. Decode path
    // syntax before WHATWG dot-segment removal, also covering later path lookups.
    // Collapse slashes before parsing so a doubled leading slash is not an authority.
    const pathname = target.split(/[?#]/, 1)[0]
      .replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
        const value = String.fromCharCode(Number.parseInt(hex, 16));
        return /[a-z0-9_./\\-]/i.test(value) ? value : encoded;
      }).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    try {
      const normalized = new URL(pathname, "http://operations.invalid").pathname;
      const alias = claimedSurface(normalized);
      if (alias) return { claimed: true, operation: null, surface: alias };
    } catch { /* Invalid legacy targets retain their existing dispatch. */ }
    return { claimed: false };
  }
  if (surface === "api" && !target.startsWith("/api/operations/")) return { claimed: true, operation: null, surface };
  if (surface === "mcp") return { claimed: true, operation: null, surface };
  const id = target.slice("/api/operations/".length);
  return { claimed: true, surface, operation: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id) && ids.includes(id) ? id : null };
}

function claimedSurface(target: string): "api" | "mcp" | null {
  const claims = (namespace: string) => target.startsWith(namespace)
    && (target.length === namespace.length || "/?%\\#".includes(target[namespace.length]));
  return claims("/api/operations") ? "api" : claims("/mcp/operations") ? "mcp" : null;
}
