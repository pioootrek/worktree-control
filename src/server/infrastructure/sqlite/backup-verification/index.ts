// Narrow public entry for the short-lived verifier child. Importing the main
// SQLite barrel also loads the controller store, Knowledge and restore graph.
export { verifyBackupSnapshot } from "../verify-backup-snapshot";
