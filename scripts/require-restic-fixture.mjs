if (!process.env.WORKTREE_SWITCHER_TEST_RESTIC || !process.env.WORKTREE_SWITCHER_TEST_REST_SERVER) {
  throw new Error("Remote acceptance requires verified disposable restic/rest-server paths in WORKTREE_SWITCHER_TEST_RESTIC and WORKTREE_SWITCHER_TEST_REST_SERVER.");
}
