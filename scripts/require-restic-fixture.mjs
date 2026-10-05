import { scriptEnvironment } from "./package-install.mjs";

if (!scriptEnvironment("WORKTREE_CONTROL_TEST_RESTIC") || !scriptEnvironment("WORKTREE_CONTROL_TEST_REST_SERVER")) {
  throw new Error("Remote acceptance requires verified disposable restic/rest-server paths in WORKTREE_CONTROL_TEST_RESTIC and WORKTREE_CONTROL_TEST_REST_SERVER.");
}
