/** One line per real top-level command; detailed options live in each command's usage and the docs. */
export const CLI_HELP = [
  "Usage: worktree-control <command> [options]   (alias: wtc)",
  "",
  "Commands:",
  "  start              Run the controller in this terminal (default command; --host, --port, --mcp-port, --data-dir, --state-dir)",
  "  service            Manage the user service: install, status, start, stop, restart, url, open, uninstall",
  "  auth               Authentication: status, token generate, token rotate, mode set <open|token|better-auth> (applies after service restart)",
  "    provider         Protected maintenance: status [--principal-id ID], configure, owner create, enroll/recover --principal-id ID",
  "                     human create|list [--limit N --after ID]|disable --principal-id ID",
  "                     runtime-access list --principal-id ID [--limit N --after ID]; set|revoke --input-stdin|--input-file PATH",
  "                     knowledge-access list --principal-id ID [--limit N --after ID]; set|revoke --input-stdin|--input-file PATH",
  "                     configure/enroll/recover require --input-stdin or --input-file ABSOLUTE_PATH (strict private JSON; no secret arguments)",
  "  backup             Installation backups: create, restore, now, list, status, monitor, remote, export-project, import-project, user-cleanup",
  "  project            Registered projects: add <path>, list, remove <id>",
  "  doctor             Check Node.js, Git and the application state",
  "  test-run           Local operator, one exact run via the owner socket: inspect <run-id>, stop <run-id> --reason TEXT [--wait-seconds N]",
  "  knowledge          Project knowledge operations and Hub imports",
  "  identity           Owners, agents, runtime delegations/credentials and knowledge grants",
  "  vault              DEV-only encrypted vault; signed owner approval, JSON on stdin",
  "  remote-verification  Local owner provisioning: provision --file FILE, revoke-token --credential-id ID; start opts in with --remote-verification-config FILE",
  "  sandbox            Throwaway loopback controller for test suites; prints one JSON line, removes everything on stop",
  "  config mcp         Print the MCP client configuration",
  "  config path        Print the database path",
  "  mcp diagnostics    Print MCP session diagnostics of the running controller",
  "  help, --help, -h   Show this help",
  "  --version, -v      Print the version",
  "",
  "Scoped runtime actions: projects:read, claims:manage, runtime:control, profiles:select, config:write (preset timeouts only).",
  "Runtime delegation and credential administration requires a private owner session.",
  "",
  "Guides: README.md and docs/ in the installed package.",
].join("\n");

const HELP = new Set(["help", "--help", "-h"]);
const VERSION = new Set(["--version", "-v"]);

/**
 * Help and version requests answered before any option parsing, path resolution or lock, so they
 * never start a controller or touch the data and state directories.
 */
export function cliInformation(args: readonly string[], version: string): string | null {
  const [first] = args;
  if (first === undefined) return null;
  if (HELP.has(first)) return CLI_HELP;
  if (VERSION.has(first)) return version;
  return null;
}
