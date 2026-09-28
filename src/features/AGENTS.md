# Dashboard features

`dashboard/use-dashboard.ts` owns the browser session, dashboard refresh,
mutation notifications, one SSE subscription, and one metrics polling timer.
Feature compositions receive snapshots and mutation callbacks; adding a panel
must not create another dashboard subscription.

Keep worktree-dependent keys on the test and storage panels. Their selection
state must be recreated when the selected target changes. Preserve the dialog
open/close boundaries that initialize draft settings from the current snapshot.

The static-export browser tests exercise real components with a fixture API and
no listening server. See [module development](../../docs/module-development.md)
for setup and their integration limits.

For layout, controls, readers or dialogs, follow the [UI standards](../../docs/ui-standards.md).
