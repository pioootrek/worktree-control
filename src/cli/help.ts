/** One line per real top-level command; detailed options live in each command's usage and the docs. */
export const CLI_HELP = [
  "Usage: worktree-control <command> [options]   (alias: wtc)",
  "",
  "Commands:",
  "  start              Run the controller in this terminal (default command; --host, --port, --mcp-port, --data-dir, --state-dir)",
  "  service            Manage the user service: install, status, start, stop, restart, url, open, uninstall",
  "  auth               Authentication: status, token generate, token rotate, mode set <open|token|better-auth>",
  "  backup             Installation backups: create, restore, now, list, status, monitor, remote, export-project, import-project, user-cleanup",
  "  project            Registered projects: add <path>, list, remove <id>",
  "  doctor             Check Node.js, Git and the application state",
  "  knowledge          Project knowledge operations and Hub imports",
  "  identity           Owners, agents, agent tokens and knowledge grants",
  "  config mcp         Print the MCP client configuration",
  "  config path        Print the database path",
  "  mcp diagnostics    Print MCP session diagnostics of the running controller",
  "  help, --help, -h   Show this help",
  "  --version, -v      Print the version",
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
