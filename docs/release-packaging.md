---
audience: "maintainers building, verifying and handing over Worktree Control release artifacts"
last_reviewed: "2026-11-08"
source_of_truth: "release artifact contract for the Community package and the optional account provider"
status: "active"
---

# Release packaging

A release has two independent artifacts built from the same clean commit:

| Artifact | CI artifact name | Distribution | License |
| --- | --- | --- | --- |
| Community package `worktree-control-<version>.tgz` | `portable-package` | npm registry, published from the CI tarball | MIT |
| Optional Better Auth provider `worktree-control-auth-provider-better-auth-proof-0.0.0.tgz` | `optional-auth-provider` | Separate artifact; never an npm dependency | MIT, with bundled third-party notices |

The Community package works on its own in `open` and `token` modes. Account mode
(`better-auth`) additionally needs the provider installed into its own prefix.
The Community dependency graph, `dist/cli` and `out` contain no provider engine.

## Community package

`scripts/package-trial.mjs` packs the Community tarball and writes
`SHA256SUMS`, `provenance.json` and the installer companions. Publication
follows [Publish a release](package-trial.md#publish-a-release).

## Optional provider artifact

`pnpm test:package:provider` (or `node scripts/package-provider.mjs --output
<empty-directory>`) builds the provider twice, refuses a release if the two
tarballs differ and writes, by default to `dist/provider-release/`:

```text
worktree-control-auth-provider-better-auth-proof-0.0.0.tgz
npm-shrinkwrap.json
THIRD_PARTY_NOTICES.md
LICENSE
INSTALL.md
SHA256SUMS
provenance.json
```

`provenance.json` names the source commit and its `dirty` state, the tarball
and lock digests, the provider contract (`5`) and implementation
(`0.0.0-proof.5`), and the compatible Community version. The provider
`package.json` is `private: true`, so `npm publish` refuses it.

Dependencies are locked by the committed
`packages/auth-provider-better-auth-proof/release/npm-shrinkwrap.json`. The
build copies it into the tarball and never resolves versions from the registry.
`node scripts/provider-lock.mjs --check` (also run by the unit suite) requires
every shipped package version to be the one tested through `pnpm-lock.yaml`,
and requires `THIRD_PARTY_NOTICES.md` to list exactly the shipped closure. After
changing provider dependencies, run `pnpm install`, then
`node scripts/provider-lock.mjs --write`, and update the notices.

Install and verify the provider without a source checkout:

```bash
sha256sum --check SHA256SUMS
npm install --prefix "$PROVIDER_PREFIX" --omit=dev --ignore-scripts \
  ./worktree-control-auth-provider-better-auth-proof-0.0.0.tgz
```

The module path for `auth provider configure` is
`$PROVIDER_PREFIX/node_modules/@worktree-control/auth-provider-better-auth-proof/dist/index.js`.
Follow the staged account-mode procedure in
[authentication](authentication.md#separate-provider-artifact-and-staged-migration).

## Installed acceptance

`scripts/package-rbac.mjs` installs the Community tarball and the provider into
separate temporary prefixes and drives only installed executables:

| Baseline | Command | What it proves |
| --- | --- | --- |
| `public-0.1.1` (default) | `pnpm test:rbac-artifact` | The registry `worktree-control@0.1.1` (schema 28, pinned sha256/sha512) seeds owner, agent grant, token and Knowledge history; the candidate refuses before fence establishment, migrates to schema 49 and preserves them; token and open modes work without a provider; then provider enrollment of the existing owner, explicit RBAC selection, login, scoped MCP, revocation, TOTP replay, rollback fence and protected recovery |
| `fresh` | `pnpm test:rbac-artifact:fresh` | The same account-mode flow on a new candidate installation, whose fence is current without establishment |
| historical installed | `node scripts/package-rbac.mjs <input.json>` | An explicitly fingerprinted installed old package, such as the earlier schema-43 trial |

Both package scripts test the exact `dist/provider-release/` directory. Pass
`--community <tgz> --community-sha256 <hex> --provider-dir <directory>` to test
exact CI artifacts instead of packing the checkout. Each run writes
`dist/rbac-artifacts/acceptance-<baseline>.json` unless `--report` is given. A
schema-43 result does not prove an upgrade from the public `0.1.1` release.

## Open owner decisions

- Where the provider is published, if anywhere. The proposed route is a
  GitHub Release asset beside the Community tarball; the MIT license and the
  notices permit redistribution. Until the owner decides, the provider remains
  a CI artifact and a separately delivered local artifact, as stated in
  [authentication](authentication.md#separate-provider-artifact-and-staged-migration).
- Whether the provider keeps the historical `-proof` package name and `0.0.0`
  package version for this release. Renaming changes the installed module path
  that existing account-mode configurations reference.
- How release notes describe account mode while the full provider proof keeps
  its five historical native `factor-compatibility` failures.
