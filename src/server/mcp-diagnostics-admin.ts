/** Local-only application read, shared by the owner socket and its CLI client. */
export function mcpDiagnosticsAdminHandler(read: () => Promise<unknown>) {
  return (body: unknown): Promise<unknown> => {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
      || !("command" in body) || body.command !== "mcp-diagnostics") throw new Error("Invalid MCP diagnostics request.");
    return read();
  };
}
