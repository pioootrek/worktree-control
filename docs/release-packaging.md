---
audience: "maintainers building, verifying and handing over Worktree Control release artifacts, and operators installing the optional account provider"
last_reviewed: "2026-11-08"
source_of_truth: "release artifact contract for the Community package and the optional account provider"
status: "active"
---

# Release packaging

This page is also shipped as `INSTALL.md` inside the optional provider
download, so its links point to the versioned documentation. Replace `v0.2.0`
in a link with your release tag when you read it for another version.

A release has two independent artifacts built from the same clean commit:

| Artifact | CI artifact name | Distribution | License |
| --- | --- | --- | --- |
| Community package `worktree-control-<version>.tgz` | `portable-package` | npm registry, published from the CI tarball | MIT |
| Optional Better Auth provider `worktree-control-auth-provider-better-auth-proof-0.0.0.tgz` | `optional-auth-provider` | Attached to the GitHub Release of the same version; never on npm and never an npm dependency | MIT, with bundled third-party notices |

The Community package works on its own in `open` and `token` modes. Account mode
(`better-auth`) additionally needs the provider installed into its own
directory. The Community dependency graph, `dist/cli` and `out` contain no
provider engine. No commercial license, entitlement or hosted signup is part of
either artifact.

## Community package

`scripts/package-trial.mjs` packs the Community tarball and writes
`SHA256SUMS`, `provenance.json` and the installer companions. Publication
follows
[Publish a release](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/package-trial.md#publish-a-release).

## Optional provider artifact

### What it is

The provider package keeps its historical name
`@worktree-control/auth-provider-better-auth-proof` and package version `0.0.0`.
It began as the account-mode proof, and the controller checks the loaded
module's capabilities, not its name: provider contract `5`, storage revision
`3`, implementation `0.0.0-proof.5` and Better Auth `1.7.14`. Renaming it would
change the module path that existing account-mode configurations reference, so
the name stays for compatibility. Because the package version never changes,
identify a release's provider by its `provenance.json`, not by its file name.

The download contains:

```text
worktree-control-auth-provider-better-auth-proof-0.0.0.tgz
npm-shrinkwrap.json
THIRD_PARTY_NOTICES.md
LICENSE
INSTALL.md
SHA256SUMS
provenance.json
```

`provenance.json` records:

- `compatibleCore.version`: the Community version this provider is for, `0.2.0`
  for this release;
- `source.commit` and `source.dirty`: the full release commit, which must be
  `false` for dirty;
- `artifact.sha256` and `dependencyLock.sha256`: the tarball and lock digests;
- `provider.contract` (`5`) and `provider.implementationVersion`
  (`0.0.0-proof.5`);
- `reproducibility`: two builds, identical;
- `ci.runUrl`: the CI run that built it.

### Install

Install without a source checkout, on the same machine and OS user as the
controller. You need Node.js 22 or newer, npm, `tar` and registry access for
`npm ci`.

```bash
sha256sum --check SHA256SUMS
umask 077
PROVIDER_DIR="$HOME/.local/lib/worktree-control-provider-0.2.0"
mkdir "$PROVIDER_DIR"
tar -xzf worktree-control-auth-provider-better-auth-proof-0.0.0.tgz \
  -C "$PROVIDER_DIR" --strip-components=1 --no-same-owner
npm ci --prefix "$PROVIDER_DIR" --omit=dev --ignore-scripts
ls "$PROVIDER_DIR/dist/index.js"
```

Before installing, confirm that `provenance.json` names the expected
`compatibleCore.version`, commit and `"dirty": false`, and that
`artifact.sha256` equals the tarball line in `SHA256SUMS`.

Do not use `npm install <tarball>`: npm ignores a dependency's
`npm-shrinkwrap.json` there and resolves newer transitive versions than the
tested lock. `npm ci` in the extracted directory installs exactly the shipped
lock. Keep the directory private: the controller refuses a module that other
users can modify, and the private `umask` above prevents group-writable files.
The directory name is an example; any private path outside Git working trees
works.

The module path for `auth provider configure` is `$PROVIDER_DIR/dist/index.js`.
Continue with
[Turn on account mode](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md#turn-on-account-mode).
The same guide is in the installed Community package at
`docs/authentication.md`. To find it:

```bash
package_dir="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v worktree-control)")")")")"
less "$package_dir/docs/authentication.md"
```

Keep the verified download and the installed directory for recovery. A later
`0.2.x` controller may need a different provider; check its release notes.

### Build

`pnpm test:package:provider` (or `node scripts/package-provider.mjs --output
<empty-directory>`) builds the provider twice, refuses a release if the two
tarballs differ and writes the files above, by default to
`dist/provider-release/`. The provider `package.json` is `private: true`, so
`npm publish` refuses it.

Dependencies are locked by the committed
`packages/auth-provider-better-auth-proof/release/npm-shrinkwrap.json`. The
build copies it into the tarball and never resolves versions from the registry.
`node scripts/provider-lock.mjs --check` (also run by the unit suite) requires
every shipped package version to be the one tested through `pnpm-lock.yaml`,
and requires `THIRD_PARTY_NOTICES.md` to list exactly the shipped closure. After
changing provider dependencies, run `pnpm install`, then
`node scripts/provider-lock.mjs --write`, and update the notices.

Reproducibility is checked between the two local builds of one run. Whether a
CI build is byte-identical to a local build depends on the toolchain and has not
been established; release bytes always come from CI.

## Installed acceptance

`scripts/package-rbac.mjs` installs the Community tarball and the provider into
separate temporary prefixes and drives only installed executables:

| Baseline | Command | What it proves |
| --- | --- | --- |
| `public-0.1.1` (default) | `pnpm test:rbac-artifact` | The registry `worktree-control@0.1.1` (schema 28, pinned sha256/sha512) seeds owner, agent grant, token and Knowledge history; the candidate refuses before fence establishment, migrates to schema 49 and preserves them; token and open modes work without a provider; the installed provider closure equals the shipped lock; then provider enrollment of the existing owner, explicit RBAC selection, login, scoped MCP, revocation, TOTP replay, rollback fence and protected recovery |
| `fresh` | `pnpm test:rbac-artifact:fresh` | The same account-mode flow on a new candidate installation, whose fence is current without establishment |
| historical installed | `node scripts/package-rbac.mjs <input.json>` | An explicitly fingerprinted installed old package, such as the earlier schema-43 trial |

Both package scripts test the exact `dist/provider-release/` directory. Pass
`--community <tgz> --community-sha256 <hex> --provider-dir <directory>` to test
exact CI artifacts instead of packing the checkout; the CI job
`package-rbac-acceptance` does this for both baselines. Each run writes
`dist/rbac-artifacts/acceptance-<baseline>.json` unless `--report` is given. A
schema-43 result does not prove an upgrade from the public `0.1.1` release.

## Release delivery

For `0.2.0`:

1. Publish the Community tarball from the `portable-package` CI artifact to npm,
   as in
   [Publish a release](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/package-trial.md#publish-a-release).
2. Attach every file of the `optional-auth-provider` artifact from the same CI
   run to the GitHub Release `v0.2.0`, unchanged: the provider tarball,
   `npm-shrinkwrap.json`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, `INSTALL.md`,
   `SHA256SUMS` and `provenance.json`.
3. In the release notes, identify the provider by its source commit,
   `compatibleCore.version` and tarball sha256, and link the account-mode guide.

Release notes for account mode state the verification boundary: the installed
acceptance and production composition pass, while the full provider proof
keeps five historical native `factor-compatibility` failures and is not green.
See
[Verification status and known limitations](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication.md#verification-status-and-known-limitations).
