import { resolveMcpSessionLimits, type McpSessionLimits } from "@/server/modules/mcp-sessions";

/** Flag, limit key, milliseconds per unit and the largest accepted value. */
const flags = {
  "--mcp-claim-renewal-idle-minutes": { key: "claimRenewalIdleMs", unit: 60_000, max: 1440 },
  "--mcp-session-idle-minutes": { key: "sessionIdleMs", unit: 60_000, max: 1440 },
  "--mcp-open-session-idle-minutes": { key: "openSessionIdleMs", unit: 60_000, max: 1440 },
  "--mcp-reconnect-grace-seconds": { key: "reconnectGraceMs", unit: 1000, max: 3600 },
  "--mcp-drain-seconds": { key: "drainMs", unit: 1000, max: 600 },
  "--mcp-max-sessions": { key: "maxSessions", unit: 1, max: 1024 },
  "--mcp-max-sessions-per-credential": { key: "maxSessionsPerCredential", unit: 1, max: 1024 },
} as const satisfies Record<string, { key: keyof McpSessionLimits; unit: number; max: number }>;

type Flag = keyof typeof flags;
export const MCP_SESSION_VALUE_FLAGS = Object.keys(flags);

/** Explicit MCP session options in their CLI units; omitted values use the controller defaults. */
export type McpSessionOptions = Partial<Record<Flag, number>>;

export function parseMcpSessionOptions(args: string[], allowed = true): McpSessionOptions {
  const options: McpSessionOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!(flag in flags)) continue;
    if (!allowed) throw new Error("MCP session options apply only to start or service install.");
    if (flag in options) throw new Error(`Duplicate MCP session option: ${flag}.`);
    const value = args[index + 1];
    const { max } = flags[flag as Flag];
    if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`${flag} requires an integer from 1 to ${max}.`);
    }
    options[flag as Flag] = Number(value);
    index += 1;
  }
  mcpSessionLimits(options);
  return options;
}

/** Validated limit overrides for the MCP listener. */
export function mcpSessionLimits(options: McpSessionOptions): Partial<McpSessionLimits> {
  const limits: Partial<McpSessionLimits> = {};
  for (const [flag, value] of Object.entries(options) as Array<[Flag, number]>) limits[flags[flag].key] = value * flags[flag].unit;
  resolveMcpSessionLimits(limits);
  return limits;
}

/** Service start arguments for explicitly configured values only, so default changes still apply. */
export function mcpSessionArguments(options: McpSessionOptions): string[] {
  return (Object.keys(flags) as Flag[]).flatMap(flag => options[flag] === undefined ? [] : [flag, String(options[flag])]);
}
