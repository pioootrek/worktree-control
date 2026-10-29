# Better Auth provider proof

Private, unpublished proof that Better Auth 1.7.14 with Kysely 0.28.17 can run
against the Worktree Control controller's single SQLite connection. It is not
part of the Community package, is not loaded by the controller, and does not
make the `better-auth` authentication mode selectable.

The controller loads it only from an explicit local path through
`loadAuthenticationProvider` and lends it its connection one operation at a
time. Storage comes from controller migration 38; the provider never runs
library migrations.

Run its real-library tests from the repository root:

```sh
pnpm test:auth-provider-proof
```

Upstream licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
