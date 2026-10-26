# Full CLI crash and reboot acceptance

This runbook covers the recovery gate in
[the remote verification plan](../docs/remote-verification-plan.md). Its baseline
is `c981669dc7758ada8c1ff1daca0d7592351cd5bc`. The parent owns execution and
Knowledge evidence for task `0e2204a2e0e0945eee4f754b2f932eed` and discussion
`4aa80e3623977202ad6fa9a39dfbb170` in project `k7a-worktree-switcher`.

The new integration test has not been executed during implementation. A passing
run proves crashes of the real built `dist/cli/index.js start` processes using
an actual MCP SDK client and authenticated outbound remote HTTP over loopback.
The dependency-free fixture uses a committed local bare Git repository. It
does not establish cross-host, TLS, Angular, interactive T3, or real reboot
acceptance. The earlier Angular trial and its clean stopped-controller audits
remain separate evidence; do not overwrite their roots, histories or results.

## Queue the crash test

1. Commit the intended implementation. Through Worktree Control, obtain the
   registered project, exact checkout from `list_worktrees`, and available
   presets from `list_test_presets`. The parent prepares dependencies and runs
   the managed build preset serially before this test. Changing `package.json`
   invalidates the build fingerprint even though production code is unchanged.
2. Use `run_test` with that checkout and preset
   `node:test:integration:remote-recovery`. The public command is
   `pnpm test:integration:remote-recovery`. Both the script and test check the
   integration build fingerprint. Reuse one idempotency key for transport
   retries; poll the original run to a terminal state. Never bypass an available
   queue preset. No managed development server or claim is needed.
3. Expect roughly one to three minutes on a prepared Linux host. Each case has
   a three-minute test limit, with up to two minutes for teardown. Prerequisites
   are native Linux host/boot identity, Node 22 or later, Git, npm on the worker's
   supported PATH, and built dashboard/CLI artifacts. There are no dependency
   downloads or installations inside the fixture.
4. Save the queued run ID, worktree, tested source SHA, artifact fingerprint,
   result and duration in the existing Knowledge records. Record failed attempts
   too. Inspect any retained root locally before declaring acceptance complete.
   Do not print private controller logs, owner tokens or worker credentials.

The fixture reserves five ephemeral loopback ports during setup, releasing only
its reservations before CLI bind. A competing binder causes failure, never a
port takeover. Startup requires a freshly published access record for the live
child PID and a successful authenticated MCP handshake. Broker and worker have
separate private data/state roots, fresh owner sessions, CLI-provisioned remote
grants, and projects with launch preset `none`.

The broker case waits for the command and descendant to start at the requested
SHA, kills only its live broker ChildProcess with SIGKILL, then restarts the
same installation. Replaying the exact input must retain request, attempt and
local run identity. Recovery must first report uncertainty, then accept the
surviving worker's original success with exact-SHA attribution, fingerprints
and confirmed cleanup. Replaying after completion must preserve the result.

The worker case kills only its live worker CLI handle after observing the
command and descendant. Both must survive. Offline owner inspection must
validate the original signed journal, assignment digest, boot and directory
device/inode identities. Reconcile must refuse same-boot recovery without
changing that inspection. A restart with remote configuration omitted must
block local finite admission. Restarting with remote configuration must report
the original attempt as uncertain, block admission, and never execute it again.
Natural descendant exit must neither upgrade that immutable result nor clear
the block. Same-boot recovery creates no `retained-excluded` audit; the actual
exclusion checks belong to the reboot continuation below.

Every fixture command and descendant exits naturally on release or after sixty
seconds. Teardown releases both gates and waits for exit markers and disappearance
or zombie state of the recorded process identities, their parents and their
owned process-group leaders. Procfs reads include process start time; the test
never signals a saved PID. CLI children are drained through their original
ChildProcess handles. A shutdown deadline is a failure even after a forced kill.
Unconfirmed cleanup preserves the root. The worker crash case always preserves
its root because its receipt remains uncertain. Its private root path appears
in the queue output; `source.json`, `submission.json`, `worker-recovery.json`,
the original databases/key and command markers in `events.jsonl` describe the evidence.
Broker roots are removed only after successful teardown. This fixture does not
operate production units, databases, ports, or managed development servers.

## Real reboot continuation, still unexecuted

A real machine reboot needs separate explicit consent. The crash-test
authorization does not authorize it. The parent handles consent, operations
and evidence. Do not simulate a boot change, replace procfs, edit journal JSON,
delete receipts, or infer exit from a reused PID.

1. Select the original worker installation containing the uncertain attempt.
   Its database, recovery key, workspace root and source cache must remain at
   their original canonical paths, on persistent storage that survives reboot.
   A test root under a temporary filesystem is unsuitable. Moving or copying a
   root to make it persistent destroys the required installation/directory
   identity. Use a separately prepared durable disposable installation if
   needed, and record that as a distinct acceptance run.
2. Before the consented reboot, stop the disposable controllers through their
   live supervisors. Preserve the original broker and worker data/state, remote
   configuration, assignment, exact submission, immutable uncertain result,
   source and CLI SHAs, build fingerprint, process markers and private logs.
   Record native host identity and kernel boot ID privately. Do not rotate the
   recovery key, replace the database, recreate roots/caches, or repair journal
   evidence. Keep the controller stopped throughout offline recovery.
3. Supply a current owner session privately on the worker, without putting it
   in command arguments, chat or evidence. In an interactive shell, disable
   tracing and use a hidden prompt:

   ```bash
   set +x
   read -rs -p 'Owner session: ' WORKTREE_CONTROL_OWNER_TOKEN
   export WORKTREE_CONTROL_OWNER_TOKEN
   ```

   Renew an existing owner session through supported identity operations before
   expiry if necessary. Other credentials cannot perform this recovery.
   Define `RECOVERY_CLI`, `RECOVERY_DATA`, `RECOVERY_STATE`, `ATTEMPT`, and
   `OPERATION` from the private run record. Use the same stable `OPERATION` for
   every retry of this reconciliation, including after a lost response.
4. Before reboot, save offline inspection and the expected same-boot refusal:

   ```bash
   node "$RECOVERY_CLI" remote-verification inspect --attempt-id "$ATTEMPT" --data-dir "$RECOVERY_DATA" --state-dir "$RECOVERY_STATE"
   node "$RECOVERY_CLI" remote-verification reconcile --attempt-id "$ATTEMPT" --operation-id "$OPERATION" --data-dir "$RECOVERY_DATA" --state-dir "$RECOVERY_STATE"
   ```

   Capture output privately. Confirm the signed provenance and original path
   identities, `blocked: true`, `recoverable: false`,
   `recovery_same_boot_unconfirmed`, and no audit. Record the refusal exit code.
5. After explicit consent, the operator performs one real reboot of that same
   Linux host. Do not include a reboot command in an automated crash test.
   Verify that the native kernel boot ID changed, the host identity stayed
   unchanged, and the original installation and root/cache identities survived.
   Keep the worker controller stopped. Supply the current owner token privately
   again and repeat `inspect` with the original paths. It must now show
   `recovery_ready_after_reboot`, blocked and recoverable, with the original
   signed provenance. A missing key, changed host/path, or invalid signature is
   a failed gate; preserve state and stop.
6. Run the same `reconcile` command with the stable operation ID. Require a
   signed audit for the exact attempt with `processExit` equal to
   `same-host-different-boot`, `artifacts` equal to `retained-excluded`, current
   owner/credential IDs and the newly observed boot. Inspection must retain
   the original provenance and uncertain cleanup/outcome, while reporting the
   audit. Retry the identical operation after closing/reopening the CLI and
   require the exact same saved audit. Another operation ID for that attempt,
   or that operation ID for a different attempt, must conflict when applicable.
7. Inventory retained workspace, HOME, TMP and original source-cache slots
   without traversing their contents. They must remain in place or remain
   absent as previously observed. Reconciliation must not remove or repurpose
   them. Restart the original worker without remote configuration and verify
   that the reconciled attempt alone no longer blocks finite admission; any
   other unresolved receipt must still block it. Check finite path admission
   against retained paths and symlink aliases through supported registered
   fixture worktrees where applicable. Expect refusal before execution.
8. Restore remote configuration pointing first to the original excluded cache.
   A distinct request must fail setup without executing the fixture command.
   Configure a fresh independent worker-owned clone at a different path, while
   preserving the original cache. Submit a distinct idempotency key and require
   one new exact-SHA execution in new attempt/HOME/TMP slots with confirmed
   cleanup. The original workspace root can be reused only for nonoverlapping
   new slots. No retained artifact slot or alias may become a working directory
   or preparation/cache path.
9. Through the actual MCP client, replay the original exact submission and
   require its original request, attempt and local run IDs, unchanged uncertain
   result and no new command marker. The recovery audit is local metadata; it
   does not turn an uncertain execution into a pass. Save all evidence under a
   new recovery phase without overwriting the crash or Angular histories.
   Unset the private owner-token environment variable when finished.

The interactive T3 gate remains separate: use the existing T3 MCP connection
to submit/read a real request and verify its displayed source/result evidence.
An SDK fixture or successful reboot cannot establish that client behavior.
