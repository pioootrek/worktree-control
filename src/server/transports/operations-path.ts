/** Claim on the raw target, before URL normalization or any legacy dispatch. */
export function parseOperationsPath(target: string, ids: readonly string[]):
  { claimed: false } | { claimed: true; operation: string | null; surface: "api" | "mcp" } {
  const surface = claimedSurface(target);
  if (!surface) {
    // Refusal only: never turn an alias into an executable operation.
    for (const alias of normalizedForms(target)) {
      const claimed = claimedSurface(alias);
      if (claimed) return { claimed: true, operation: null, surface: claimed };
    }
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

const decodePathSyntax = (value: string) => value.replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
  const decoded = String.fromCharCode(Number.parseInt(hex, 16));
  return /[a-z0-9_./\\-]/i.test(decoded) ? decoded : encoded;
}).replace(/\\/g, "/");

/**
 * Every pathname a later reader could derive from this target. The legacy
 * dispatcher parses the ORIGINAL target with the WHATWG URL parser, so a
 * network-path reference (`//host/api/operations/...`) or an absolute-form
 * target yields that pathname with the authority removed; other lookups may
 * decode dots and separators or collapse doubled slashes. Each form is parsed
 * as it stands and after decoding and collapsing, until nothing new appears.
 */
function normalizedForms(target: string): string[] {
  const seen = new Set<string>();
  let frontier = [target.split(/[?#]/, 1)[0]];
  for (let round = 0; round < 4 && frontier.length > 0; round++) {
    const next: string[] = [];
    for (const form of frontier) {
      const decoded = decodePathSyntax(form);
      for (const shaped of [form, decoded, form.replace(/\/{2,}/g, "/"), decoded.replace(/\/{2,}/g, "/")]) {
        let pathname: string;
        try { pathname = new URL(shaped, "http://operations.invalid").pathname; } catch { continue; }
        if (!seen.has(pathname)) { seen.add(pathname); next.push(pathname); }
      }
    }
    frontier = next;
  }
  return [...seen];
}
