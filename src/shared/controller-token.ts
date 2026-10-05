/** Request header carrying the dashboard pairing token or the installation token. */
export const CONTROLLER_TOKEN_HEADER = "X-Worktree-Control-Token";

/** Pre-rename header name. The controller still accepts it while older clients are upgraded. */
export const LEGACY_CONTROLLER_TOKEN_HEADER = "X-Worktree-Switcher-Token";
