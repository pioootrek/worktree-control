---
audience: "people running Worktree Control and choosing how callers authenticate"
last_reviewed: "2026-11-20"
source_of_truth: "authentication modes, identities, optional account mode and protected recovery for the 0.2.0 release candidate"
status: "active"
---

# Authentication

This guide describes the `0.2.0` release candidate. It covers the three
authentication modes, owner and agent identities, the optional individual
account mode and the protected recovery commands. For upgrading a `0.1.1`
installation, read [Upgrade from 0.1.1 to 0.2.0](package-trial.md#upgrade-from-011-to-020)
first. Implementation history and internal contracts are kept in the
[authentication reference](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication-reference.md).

## Describe local authority (integration branch)

`worktree-control session describe` prints the local operator's authority as
JSON. It requires no token. With a running controller it uses the private unix
socket, reporting listener `unix`:

```bash
worktree-control session describe --data-dir /tmp/wtc-example/data --state-dir /tmp/wtc-example/state
```

After stopping that same example controller, the identical command acquires the
singleton lock and reads offline, reporting listener `offline`:

```bash
worktree-control session describe --data-dir /tmp/wtc-example/data --state-dir /tmp/wtc-example/state
```

Use directories of an existing synthetic installation, or substitute your own
installation directories. The lock selects the path; there is no path-selection
flag. A taken lock with an unavailable socket fails with exit 1 and never opens
the database offline. All three supported modes report operator authority;
legacy installations refuse `unknown_mode`. Success exits 0. Operations
failures print public category, reason and retry fields as JSON on stderr.
Offline output is committed to the process's stdout stream inside the admitted
phase and drains asynchronously; the socket path writes after validating the reply.
Slow or late readers receive the complete JSON and exit 0, with no drain deadline.
The process stays alive for pending writes; offline cleanup drains and closes the
store, then releases the lock without waiting for stdout to flush.
A stdout whose reader has gone away, or a failing stdout stream, exits 1 with
`unavailable / output_unavailable` in that error envelope, without a stack
trace; if stderr is also closed, exit 1 is silent. Node replaces a standard
descriptor that is already closed when the process starts with the null
device, so that case succeeds and prints nothing. If a pipe closes
mid-write, a consumer may receive truncated JSON on stdout; the command exits 1
with the sanitized error on usable stderr.
See the [error mapping](authorization-contract.md#mounted-cli-boundary-d1a-8b).

## Describe authority through each listener (integration branch)

These requests use an existing synthetic installation. Set `WTC_API` and
`WTC_MCP` to its API and MCP origins, and `WTC_WORKER` to its HTTPS worker
origin. Read the installation token in token mode, or an agent token in better-auth
mode, without echo. Keep secrets out of shell history; do not replace the
placeholder by typing a token into an assignment. Open mode omits the Authorization header entirely; supplying a token
there refuses `credential_in_open_mode`.

```bash
WTC_API='http://127.0.0.1:4310'
WTC_MCP='http://127.0.0.1:4311'
WTC_WORKER='https://127.0.0.1:4312'
# Press Enter in open mode. Otherwise enter the installation or agent token.
IFS= read -r -s -p 'Bearer token (empty for open mode): ' WTC_BEARER
printf '\n'
WTC_HEADER_FILE=$(mktemp)
chmod 600 "$WTC_HEADER_FILE"
trap 'rm -f -- "$WTC_HEADER_FILE"; unset WTC_BEARER WTC_HEADER_FILE' EXIT
if [[ -n $WTC_BEARER ]]; then
  printf 'Authorization: Bearer %s\n' "$WTC_BEARER" > "$WTC_HEADER_FILE"
fi
unset WTC_BEARER
```

These Bash examples assume curl 7.76.0 or newer (`--fail-with-body`). Its
[7.76.0 header manual](https://github.com/curl/curl/blob/curl-7_76_0/docs/cmdline-opts/header.d)
supports `-H @file` (available since 7.55.0). The private header file keeps the
secret out of curl's argument list and leaves stdin available for MCP JSON.
After the last request, run `rm -f -- "$WTC_HEADER_FILE"; unset WTC_HEADER_FILE`;
the exit trap also removes it when the shell exits.

API bearer (`operations-api-${mode}` in the installed RBAC script):

```bash
curl --fail-with-body "$WTC_API/api/operations/session.describe" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' --data '{}'
```

A missing token in token/account mode refuses `credential_required` (401).
The token-mode response has this shape; permission arrays and project IDs depend
on the fixture. The account-mode agent has `actor.kind: "agent"`, its own
`accountId`, `fullAuthority: false` and fresh login `unavailable`.

```json
{"actor":{"kind":"installation","accountId":null},"mode":"token","listener":"api","fullAuthority":true,"installationPermissions":["accounts:manage"],"projects":[{"projectId":"example","permissions":["project:read"]}],"projectsTruncated":false,"freshLogin":{"state":"exempt","validUntil":null}}
```

Arrays above are abbreviated examples, not the complete installation permission
set. Refusals use a closed envelope, for example:

```json
{"error":{"category":"unauthenticated","status":401,"reason":"credential_required","retry":"reauthenticate","effect":null}}
```

For a provider cookie, sign in through the configured HTTPS browser origin in
better-auth mode, then run this in that origin's developer console. The browser
sends its existing secure, HttpOnly session cookie and canonical Origin. Do not
copy a cookie into a curl command. The installed provider acceptance step
`public-packaged-login-and-transport-denial-matrix` performs this login and POST.

```javascript
await (await fetch('/api/operations/session.describe', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' }, body: '{}'
})).json()
```

The DTO has `actor.kind: "human"`, the account ID, `mode: "better-auth"` and
`listener: "api"`; fresh login reports `satisfied` with an ISO `validUntil`, or
`stale`. An expired or signed-out cookie refuses `invalid_credential` (401).
A wrong Origin refuses `origin_forbidden` (403), verified by the installed
`public-packaged-login-and-transport-denial-matrix` step. Signed-out cookies are
verified by installed `logout-and-ordinary-restart`. Expiry is verified by
`session expired: unauthenticated at admission, before the effect and at release`
in `provider-session-verifier.test.ts`, not by the installed script. Adding a bearer to the cookie
refuses `mixed_credentials`, even if the cookie is invalid.

The private admin socket accepts the machine operator without a credential
(`operations-unix-${mode}`). Use the controller's actual state directory:

```bash
curl --fail-with-body --unix-socket /tmp/wtc-example/state/admin.sock \
  http://localhost/api/operations/session.describe \
  -H 'Content-Type: application/json' --data '{}'
```

The same DTO has `actor: {"kind":"operator","accountId":null}`, the active
mode, `listener: "unix"`, `fullAuthority: true` and fresh login `exempt`.
A supplied bearer refuses `credential_on_local_listener` (401). Browser headers
refuse `browser_headers_on_unix`; a recognized provider cookie refuses
`provider_cookie_not_supported`. All three unix refusals are verified by
installed `operations-unix-${mode}`. Filesystem access failures occur before HTTP.

The configured worker listener requires TLS. Point `--cacert` to the fixture CA
that signed its certificate (`operations-worker-${mode}`); do not disable
certificate verification:

```bash
curl --fail-with-body --cacert /tmp/wtc-example/worker-ca.pem \
  "$WTC_WORKER/api/operations/session.describe" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' --data '{}'
```

The DTO has `listener: "worker"`, the active mode and installation authority in
open/token modes, or the agent's authority in better-auth mode. Missing credentials
refuse `credential_required` outside open mode. A stored worker protocol token
refuses `credential_not_accepted_here` in token mode and `invalid_credential` in
better-auth mode; provider cookies refuse `provider_cookie_not_supported`. All
are verified by installed `operations-worker-${mode}`.

> **Open mode and an exposed worker port.** In `open` mode this request needs no
> credential, so anyone who can reach the worker port and complete TLS receives
> the installation's authority description, including up to 500 project IDs
> with their permissions (no names, paths, secrets or history). Until this is
> decided before the release (a recorded release blocker), keep the worker
> listener on `127.0.0.1` or `::1` in `open` mode, or use `token` or
> `better-auth` mode before exposing it. Poll and report still require a worker
> token in every mode. See the [changelog](../CHANGELOG.md) and
> [owner decision 4(b)](authorization-contract.md#mounted-worker-boundary).

MCP uses a separate port and the exact `/mcp/operations` path. Each POST is
stateless and authenticates independently. No session ID is needed. This exchange
is executed verbatim as JSON messages by `describe-rpc-${mode}` in the installed
RBAC script, as well as through the installed SDK client:

```bash
curl --fail-with-body "$WTC_MCP/mcp/operations" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data-binary @- <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"authority-example","version":"1"}}}
JSON
curl --fail-with-body "$WTC_MCP/mcp/operations" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data-binary @- <<'JSON'
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
JSON
curl --fail-with-body "$WTC_MCP/mcp/operations" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data-binary @- <<'JSON'
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"session_describe","arguments":{}}}
JSON
```

Replies retain JSON-RPC `id`. Initialize returns `result.protocolVersion` and
server capabilities; list returns only `session_describe` in `result.tools`.
Call returns the DTO in `result.structuredContent`, plus its JSON text in
`result.content`, with `listener: "mcp"`. Missing credentials refuse
`credential_required` before SDK dispatch (installed `describe-rpc-${mode}`).
Legacy secret header names always
refuse `legacy_credential`, even when their value is a valid token. Tool argument
refusals appear in a tool result with `isError: true`; release refusals after SDK
construction use JSON-RPC error `-32000` with the public error in `error.data`.
Tool-argument refusals are verified by `describe-rpc-${mode}` in the installed
script and `returns safe tool refusals without losing operations reasons` in
`mcp-request-adapter.test.ts`. Post-SDK release refusals are verified by
`post-SDK-buffer release rechecks %s` in `http-boundary-conformance.test.ts`,
not by the installed script.

The [local CLI examples](#describe-local-authority-integration-branch) above run
the same command through the socket while the fixture controller owns the lock,
and offline once it stops. Installed steps `operations-unix-${mode}` compare the
CLI output with the socket DTO; `operations-offline-${mode}` checks operator,
listener and mode offline. The common socket refusal is `admin_socket_missing`
(exit 1, no offline fallback). An older database offline reports the existing
`upgrade_required` diagnostic and `nextStep: "upgrade inspect"`; the installed
`upgrade-required-offline-session-describe` step verifies it on the released
baseline. CLI accepts no token or path-selection switch.

Verification mapping covers request bytes and response semantics with dynamically
allocated fixture ports, paths and secrets. The scripts use Node HTTP/TLS clients
and the installed CLI, so the shell's curl executable itself is not under test.
See the complete [gate evidence and artifact matrix](authorization-gate-evidence.md).

## Read projects through each listener (integration branch)

The first project read family (D2a) is `project.list`, `project.status` and
`project.worktrees`. It is served on the API listener, the private unix socket,
MCP and the CLI. The HTTPS worker listener does not serve it in any mode; such a
request is refused with `operation_not_found` (404). Use the same synthetic installation,
`WTC_API`, `WTC_MCP` and private header file as in the
[previous section](#describe-authority-through-each-listener-integration-branch).
A project is a Knowledge project; its registrations carry the port, runtime phase
and worktree. A project with no registration has an empty list.

```bash
curl --fail-with-body "$WTC_API/api/operations/project.list" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' --data '{"limit":50}'
curl --fail-with-body "$WTC_API/api/operations/project.status" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' --data '{"projectId":"example"}'
curl --fail-with-body "$WTC_API/api/operations/project.worktrees" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' --data '{"projectId":"example"}'
```

`project.list` returns `{"items":[...],"nextCursor":null}`. It filters items before
pagination; pass `nextCursor` back as `cursor` for the next page (`limit` 1 to 100,
default 50). Each item has `projectId`, `name`, `status` (`active` or `archived`),
up to 16 `registrations` sorted by ID and `registrationsTruncated`. A registration
lists `registrationId`, `name`, `port`, `phase`, `worktreePath` and `claim`
(`none` or `other`; see [limits](authorization-contract.md#project-reads-d2a)).
A registration without a project appears only to full authority, as an item with
`projectId: null`.

`project.status` adds the project's Knowledge `revision`, whether the caller may
write Knowledge there (`writable`), and per registration `selectedWorktreePath`,
`startedAt` and `managedServer`. `launch` (executable and arguments) appears only
with `config:read` on the project. `claimHolder` appears only with `claims:manage`
and an active claim, and names only the holder (`kind`, `accountId`), never the
claim's reason or times. `{"compact":true}` returns the list's registration
entries instead. `project.worktrees` discovers Git worktrees on every call. For
each registration it returns `discovery` (`complete`, `partial` when Git could
not read a tree's status, or `unavailable`) and up to 64 worktrees in total with
`path`, `branch`, `head`, `shortHead`, `detached`, `locked`, `prunable` and
`dirty` (null when its status could not be read).

An account with no role on any project gets an empty list. A hidden project and a
missing project both refuse `resource_not_found` (404). A project visible only
through `secrets` or `executor` refuses `permission_denied` (403). The installed
RBAC script verifies this in `project-reads-${mode}` with the account-mode agent,
which holds no role after the upgrade's authority reset.

Over MCP, `tools/list` returns `project_list`, `project_status`,
`project_worktrees` and `session_describe`. Call a project tool with the same
arguments as the HTTP body:

```bash
curl --fail-with-body "$WTC_MCP/mcp/operations" \
  -H "@$WTC_HEADER_FILE" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data-binary @- <<'JSON'
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"project_list","arguments":{"limit":50}}}
JSON
```

A tool refusal is a tool result with `isError: true` and the public error as
`structuredContent`, decided by the tool itself as on HTTP. If authority
changes between the buffered answer and its write, the request answers a
JSON-RPC error carrying the fresh public error instead. The local operator uses the CLI. Like `session describe`,
it goes through the private socket while a controller owns the lock and reads
offline otherwise. Offline, every registration reports `phase: "stopped"`:

```bash
worktree-control projects list --data-dir /tmp/wtc-example/data --state-dir /tmp/wtc-example/state
worktree-control projects status example --data-dir /tmp/wtc-example/data --state-dir /tmp/wtc-example/state
worktree-control projects worktrees example --data-dir /tmp/wtc-example/data --state-dir /tmp/wtc-example/state
```

The legacy `project list` command and the legacy MCP and HTTP project routes are
unchanged until their families are migrated.

## What this release provides

Implemented in `0.2.0`:

- **Modes.** `token` (the default for new installations), `open`, and the
  optional individual account mode `better-auth`. Installations that predate
  modes keep `legacy` until migrated.
- **Owner and agent identities** in every mode except `open`: Knowledge grants
  and project roles, owner-sponsored scoped runtime credentials for agents, and
  explicit diagnostic grants (logs, cached storage, aggregate capacity).
- **Account mode** with the separately installed optional provider: password
  sign-in for the existing owner and for ordinary human accounts created by the
  operator, optional TOTP and passkeys, per-project human Knowledge and runtime
  permissions, an account dashboard, and protected CLI recovery.
- **External security fence** (schema 49): detects a restored or rolled-back
  database and requires a protected resume that quarantines restored
  credentials, sessions and grants.

Not provided: ENV roles, invitations, self-service signup, browser account
recovery, delegated (non-owner) account administration, factor removal or
replacement in the browser, recovery codes, a hosted or SaaS account service,
and any commercial license or entitlement. Accounts are optional; `token` and
`open` modes work without the provider.

## Modes

One authentication policy applies to the dashboard, the HTTP API, live updates,
MCP and the online CLI.

| Mode | Who uses it | Access |
| --- | --- | --- |
| `token` | New installations | One shared installation token with installation-wide authority, including Knowledge; cannot sponsor scoped runtime agents |
| `open` | Explicit choice on a trusted loopback machine | Anonymous installation-wide authority; cannot sponsor scoped runtime agents |
| `better-auth` | Explicit protected CLI selection after provider setup | Individual human sessions and individual agent credentials; operations without an account-mode route are denied |
| `legacy` | Installations created before modes existed | Browser pairing token, MCP `mcp-token`, owner sessions for Knowledge |

Scoped agent tokens from `identity` commands work in `legacy`, `token` and
`better-auth` modes. Owner sessions work in `legacy` and `token` modes; in
account mode they authorize only protected local administration over the
private socket. `legacy` is upgrade compatibility only and cannot be selected
again.

### How a mode is selected

- **CLI only.** `worktree-control auth mode set <open|token|better-auth>` is the
  only selector. The dashboard, HTTP API and MCP have none.
- **Restart only.** The command stores the selection for the next start. The
  running controller keeps its mode until an explicit restart. Selecting the
  active mode cancels a pending selection.
- **No fallback.** A controller whose stored mode cannot start refuses to start.
  A missing or failed provider, a different HTTPS origin, an unenrolled owner or
  a failed security fence never falls back to `token` or `open`.
- **Live revocation.** Only the mode is captured at boot. Token rotation and
  revocation of principals, credentials, sessions, roles and delegations take
  effect immediately, even with a pending selection.

## The `auth` command

```bash
worktree-control auth status
worktree-control auth token generate
worktree-control auth token rotate
worktree-control auth mode set <open|token|better-auth>
worktree-control auth fence inspect
worktree-control auth fence establish --expect <preflight>
worktree-control auth fence resume --expect <preflight> --mode <token|open|better-auth>
worktree-control auth provider <subcommand>
```

When the controller is stopped, `auth status`, `auth token` and `auth mode`
open the database under the controller's singleton lock. When it runs, they
talk to it through an owner-only Unix socket, `admin.sock` in the state
directory. The socket is `0600` inside a `0700` directory. Access to this
private IPC channel is OS-user authority, not proof of which executable made
the request. `auth fence` commands work only with the controller stopped; see
[External security fence](#external-security-fence-and-protected-resume-p3b).
`auth provider` commands are described under
[Protected provider maintenance](#protected-provider-maintenance).

`auth mode set` saves the next-start selection and its audit atomically. It does
not restart the service, rebind listeners, disconnect clients or change live
access links. Selecting the same configured mode is a no-op. Changing modes
never generates or rotates a token; select `token` only after explicitly
generating one. `auth mode set better-auth` first loads the configured provider
and checks account readiness; it refuses with `auth_provider_unavailable` when
any requirement is missing.

Private CLI/admin status reports `mode`, `activeMode`, `configuredMode` and
`restartRequired`, alongside the existing safe token metadata and generation.
For example, running token mode after selecting open reports
`mode: token, activeMode: token, configuredMode: open, restartRequired: true`.
When stopped, `activeMode` is null, `mode` is the configured selection, and
`restartRequired` is false. These fields are private administration data, not
public browser metadata. The public `GET /api/auth/status` returns only the
active `mode` and `loginAvailable`.

Rotation invalidates the previous bearer and retained installation actors
immediately, even with a pending mode. It also closes MCP sessions and live
dashboard connections. Token generation and future-mode selection do not
disconnect them. New selectors are refused after maintenance begins, including
selectors queued behind database work.

`token generate` and `token rotate` print the token once. The first `start` or
`service install` of a new installation does the same; see
[Use token mode](#use-token-mode). The controller stores only a hash; a lost
token cannot be recovered, only rotated. Save the token in a password manager
and keep it out of issues, logs and shared shell history.

There is no command to return to `legacy`.

## Use token mode

A new installation starts in `token` mode without a token. The first
`worktree-control start` or `worktree-control service install` run from an
interactive terminal creates it, exactly as `auth token generate` would, and
prints it once with a reminder to save it. `start` then keeps running;
`service install` prints the token before the service starts, so it never
reaches the service log. Save the token in a password manager straight away.
If you lose it, run `worktree-control auth token rotate`.

The controller prints a new token only to an interactive terminal. When output
goes to a pipe, a file or a service log (CI, scripts, `--service-mode`), `start`
and `service install` refuse and ask you to run `auth token generate` first.
Run it in a terminal, save the token, then repeat the command.

- **Browser:** the dashboard asks for the token and keeps it for the browser
  tab's session. **Sign out** forgets it. `service open` and `service url` open
  the dashboard without a secret.
- **CLI against a running controller:** export `WORKTREE_CONTROL_TOKEN`.
  Offline `project` and `auth` commands need no token.
- **Knowledge and identity administration:** `identity`, `knowledge` and
  `backup` project commands accept `WORKTREE_CONTROL_TOKEN` when no owner or
  knowledge token is set. The installation token retains compatibility administration authority.
  New runtime delegation/credential commands require a real owner session.
- **MCP:** send `Authorization: Bearer <token>`. `config mcp` prints a
  placeholder, or the real token when `WORKTREE_CONTROL_TOKEN` is set.

Before the 2026-10-05 rename these variables were named `WORKTREE_SWITCHER_*`
and the dashboard header `X-Worktree-Switcher-Token`. The CLI still reads a
legacy variable when its `WORKTREE_CONTROL_*` name is unset and prints a
deprecation warning; the controller still accepts the legacy header. Move
scripts to the new names.

## Use open mode

`open` removes authentication. Use it only on a trusted, single-user machine
with the controller bound to loopback. The dashboard shows a red **open mode**
badge and the controller prints its listening address on start.

```bash
worktree-control auth mode set open
worktree-control service restart
```

The explicit restart activates the selection. Until then, the running controller
continues to enforce its previous mode.

### CLI in open mode

CLI commands need no token environment variable in `open` mode. The online
knowledge CLI and identity administration omit the `Authorization` header and
the controller applies the active mode. Offline identity administration, Hub
`knowledge execute-import` and logical `backup export-project` /
`import-project` read the persisted mode after acquiring the singleton lock.
Every such caller acts as the anonymous installation authority. New runtime
delegation/credential administration rejects that authority, even if an owner
token variable is set; use `token`, `legacy` or `better-auth` mode with an owner session. Knowledge
history records it as `authenticationMethod: none`; Hub import batches record
only the `installation` principal. A token variable set in
`open` mode is ignored. In `token` and `legacy` modes the same commands still
reject a missing, invalid or revoked credential, and scoped agent tokens keep
their grants.

## Move a legacy installation to token mode

1. Stop the controller and take a backup:
   `worktree-control service stop`, then
   `worktree-control backup create <directory>`, then
   `worktree-control service start`.
2. Generate the token and save it privately:
   `worktree-control auth token generate`. Token mode cannot be selected
   without it.
3. Select the next-start mode: `worktree-control auth mode set token`.
   Pairing and `mcp-token` keep working in the running legacy boot.
4. Restart explicitly with `worktree-control service restart`. The new boot
   applies token mode and stops accepting pairing and `mcp-token`. Sign in to
   the dashboard with the token in each browser.
5. Replace the bearer token in every MCP client with the installation token.
   Agents that use scoped `wts_` tokens need no change.
6. Export `WORKTREE_CONTROL_TOKEN` where you run online CLI commands.

If a client still fails, run `auth status` to confirm the mode and the token
prefix. Rotate the token if it may have leaked.

## Upgrade notes and breaking changes

These notes describe the move from installations created before modes existed
(schema 25). For `0.1.1` to `0.2.0`, follow
[Upgrade from 0.1.1 to 0.2.0](package-trial.md#upgrade-from-011-to-020). The
unreleased integration build's explicit upgrade to schema 52 is described in
[The explicit upgrade (unreleased integration build)](#the-explicit-upgrade-unreleased-integration-build).

Upgrading an existing installation keeps it in `legacy` mode. The pairing link,
`mcp-token` and owner sessions keep working until you migrate. These changes
apply after the upgrade:

- **No downgrade.** The upgrade applies database migration 25. Controller
  backups record schema version 25, and older versions refuse to restore them.
- **No return to `legacy`.** After a restart activates `token` or `open`,
  the pairing link and `mcp-token` stop working. A pending selection can still
  be cancelled by selecting another supported mode; `legacy` is never selectable.
- **Knowledge exports.** History entries can record the `installation_token`
  and `none` authentication methods. Older versions reject such exports.
- **Owner bootstrap over HTTP** (`/api/identity/bootstrap`) works only in
  `legacy` mode. The offline `identity bootstrap-owner` command is unchanged.

New installations differ from earlier releases:

- The first interactive `start` or `service install` creates the installation
  token and prints it once. Without an interactive terminal, both refuse until
  `auth token generate` creates it.
- The controller prints no pairing link. `service open` and `service url` show
  the sign-in page.
- `config mcp` prints a token placeholder unless `WORKTREE_CONTROL_TOKEN` is
  set.
- Online CLI commands need `WORKTREE_CONTROL_TOKEN`.

## The explicit upgrade (unreleased integration build)

The integration build mounts the read-only `session.describe` operation on
API (bearer and supported better-auth cookies), the private socket, the configured
worker listener and MCP, plus the lock-first CLI paths described above. In `token` mode, with the installation bearer
already in `WTC_INSTALLATION_TOKEN` and the controller using its default port:

```sh
curl --fail-with-body -X POST http://127.0.0.1:47831/api/operations/session.describe \
  -H "Authorization: Bearer $WTC_INSTALLATION_TOKEN" \
  -H 'Content-Type: application/json' --data '{}'
```

For the local operator, set `WTC_ADMIN_SOCKET` to the running controller's
private admin socket path. No credential is needed:

```sh
curl --fail-with-body --unix-socket "$WTC_ADMIN_SOCKET" \
  -X POST http://localhost/api/operations/session.describe \
  -H 'Content-Type: application/json' --data '{}'
```

The API accepts a provider cookie in better-auth mode with the configured public
origin and cookie boundary. A cookie combined with a bearer is refused. The unix,
worker and MCP listeners refuse provider cookies in every mode. In `legacy` mode it answers `unauthenticated` / `unknown_mode`.
Existing routes retain their authentication. Responses describe authority as
an informational hint; every later operation must authorize again.


This section describes `integration/auth-unification`, not a release. The
build runs schema 52 and never migrates an existing database at an ordinary
start. An installation's database is in one of four states:

| State | Recognised by | Ordinary opening | Operator runs |
| --- | --- | --- | --- |
| Current | trusted fence, schema 52, upgrade marker `complete` | admitted | ordinary start |
| Upgrade needed | trusted fence, and schema below 52 or marker `pending` | `upgrade_required` | `upgrade inspect`, then `upgrade apply --expect <plan hash> --backup-dir <dir>` |
| Pre-fence (the public `0.1.1` package) | no fence | `security_fence_establishment_required` | `auth fence inspect`, then `auth fence establish --expect <hash> --backup-dir <dir>`, which brings the structure to 52 with the marker pending; then upgrade needed |
| Fenced | a pending or mismatched witness, or an unacknowledged restore | `security_fence_recovery_required` | `auth fence inspect`, then `auth fence resume`; then upgrade needed |

A fresh installation is created at schema 52 with the marker `complete`. A
schema-52 database without a marker row is corrupt and refused by the database
validation, never treated as needing the upgrade.

Every ordinary opening (the controller, the service and `service install`, and
the offline `auth`, `auth provider`, `identity`, `knowledge`, `project`,
`doctor`, `config mcp`, `remote-verification` and project export and import
commands) runs the admission check before it writes anything. A fence refusal
wins over `upgrade_required`. One exception: with a restore handoff pending,
`service install` does not open the database, so it proceeds, issues no token
and starts the service; that start completes the restore and is then refused
until `auth fence resume` and the upgrade. The refusal is printed as one JSON
body on stderr with exit code 1:

```json
{"code":"upgrade_required","error":"upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.","nextStep":"upgrade inspect","state":"upgrade_needed"}
```

The upgrade commands run offline only, with the controller stopped:

```sh
worktree-control upgrade inspect [--decisions <file>] --data-dir /private/installation
worktree-control upgrade apply --expect <plan hash> --backup-dir /private/backups --data-dir /private/installation
```

`upgrade inspect` writes nothing except, in "upgrade needed", the plan it
reports: its hash, the operator's lines and the review. The decisions file is
JSON with the optional keys `links`, `bindings` and `isolate` of the project
mapping. `upgrade apply` writes `pre-upgrade-v<source schema>-<UUID>` into
the backup directory first, then executes exactly the inspected plan. Its
errors are `UpgradeError` bodies (`code`, `error`, `nextStep`, `state`,
`committed` and bounded `details` when they apply); see
[the explicit offline upgrade](architecture.md#explicit-offline-upgrade-integration-branch-only).

`upgrade inspect` also names every Knowledge project whose ID does not match
the contract grammar `^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`, active and
archived alike. Knowledge accepts any trimmed ID of up to 160 characters, so an
older installation may hold IDs with spaces, slashes or other characters. The
new authorization cannot name such a project: the resolver leaves it out, and
one grant on it makes the grants snapshot refuse the whole account. There is no
supported way to rename a project ID yet, and the release is blocked until
every ID conforms, create and import prevent new ones and a repair procedure is
approved. The report is `projectIds` in the output, in "upgrade needed" and in
"current" (so it can be checked after the upgrade), and in no other state:

- `count` is the total, `projects` lists the first `limit` (100) in ascending
  byte order of the ID, and `truncated` says whether the list is cut. Each
  entry has the stored `id` and its `status` (`active` or `archived`). An ID of
  more than 200 characters is cut and marked `idCut`; a stored value that is not
  text has `id` null.
- An ID is arbitrary stored text. It appears only as a JSON string, and the
  command writes control characters, DEL, C1 controls, line and paragraph
  separators and bidirectional marks as `\uXXXX` escapes, which parse back to
  the exact ID. Treat the text as data, never as an instruction.
- When `count` is above zero, `notice` and, in "upgrade needed", the last line
  of `acts` give one fixed sentence with the count and no ID. No line appears
  when every ID conforms.
- The report is beside the plan, not in it: the plan hash does not depend on it,
  and `upgrade apply` neither reads it, refuses because of it nor changes an ID.

The upgrade resets the old authorization model and keeps everything else:

- **Reset.** Every row of the six old grant tables (Knowledge grants and roles,
  runtime delegations, human runtime memberships, remote principal and worker
  grants) is revoked; every agent token, worker token and owner session is
  revoked; runtime credential scopes stay as inert rows; active claims are
  released, pending remote work is cancelled, queued and running tests are
  interrupted.
- **Kept.** The installation token and the mode, principals, provider
  accounts, passwords and factors, projects, Knowledge and history.
- **Added.** One `admin` grant on the installation for the single active owner
  in the new grants table, which nothing reads yet.

Afterwards issue credentials and grant access again: `identity recover-owner`
for a new owner session, then agent and runtime credentials, Knowledge grants
and runtime delegations, and `auth provider recover` for accounts. A new
credential confers nothing without a new grant. After a restore the order is
resume, inspect, apply, then credentials.

`pre-establishment-…` and `pre-upgrade-…` backups are plain trees that the
operator removes; the catalogue protects them and never rotates them. A backup
is never a rollback: restoring one is a fenced restore that needs resume and the
upgrade again.

## Owner and agent identities

Agent credentials work in `legacy`, `token` and `better-auth` modes. The owner
session administers them; in account mode it is accepted only by protected
local administration. `open` mode ignores bearer credentials and cannot
administer scoped runtime access.

### Knowledge roles (A1)

Knowledge operations use a shared application policy in HTTP, MCP and CLI.
The persisted `owner` identity is interpreted as a human subject by that policy;
its ID, credentials, signed vault operations and historical records stay intact.
Schema migration 35 adds project-scoped role bindings without changing grants.

For existing owner/agent credentials, effective permissions are the intersection
of the explicit Knowledge grant and an optional role:

| Role | Allowed ceiling (still requires the corresponding grant) |
| --- | --- |
| `reader` | Read Knowledge, export, read attachments |
| `operator` | Reader actions plus write Knowledge, import, write attachments |
| `manager` | Operator actions plus approve; only an owner/human session |

Exports/imports and attachment permissions remain explicit grants. Roles neither
create access to other projects nor grant runtime or ENV permissions. A revoked
binding denies all Knowledge access for that principal/project, including
project discovery; it never falls back to the old grant. An absent binding
preserves existing grants. Changing/revoking the grant remains an independent
restriction. Current credential, grant and role are checked for every operation,
including an idempotent retry and requests within an existing MCP session.
Discovery filters effective permissions before pagination and reports the same
write ceiling to the dashboard.

An owner session or the existing installation authority administers roles:

```bash
worktree-control identity set-knowledge-role --principal-id <id> --project-id <knowledge-id> --role reader --expected-revision 0
worktree-control identity list-knowledge-roles --principal-id <id>
worktree-control identity revoke-knowledge-role --principal-id <id> --project-id <knowledge-id> --expected-revision 1
```

First assignment requires an active Knowledge grant and revision `0`; subsequent
changes require the current binding revision. Revocation keeps a tombstone and
increments the revision. Restoring access requires an explicit new assignment
with that revision. Repeating a stale mutation returns a revision conflict
(HTTP 409); read current state before deciding whether to retry. Audit and binding
updates are atomic. Role administration is not exposed as an agent MCP tool.
The online CLI calls `/api/identity/admin`; the offline CLI uses the same service
under the controller lock. Unknown fields and role options are rejected.

The compatibility installation authority in `open`/`token` mode still bypasses
Knowledge roles. Individual human accounts use the protected membership workflow
under [account mode](#account-mode-better-auth). ENV roles are not implemented.
Runtime credential scopes and optional expiry are available through A2 below. The
shared policy denies reserved ENV actions; the existing DEV vault continues to
require its separate signed proof and exact grants, with `use` unavailable.

Full backups retain bindings, revisions, tombstones and audit. As with existing
credentials, restoring an older snapshot can restore older authorization state.
The [security fence](#external-security-fence-and-protected-resume-p3b) refuses
that snapshot until a protected resume quarantines it.

### Scoped runtime agents (A2)

A scoped agent can discover registered runtime projects, reserve one discovered
worktree, control its claimed managed server, select an existing literal profile
and configure preset timeouts. Independently delegated finite verification is
also available. The accepted runtime actions are:

| Action | Operations |
| --- | --- |
| `projects:read` | Filtered `list_projects`, safe `get_project_status`, `list_worktrees` |
| `claims:manage` | Acquire, renew and release the session's own lease |
| `runtime:control` | Start, restart and stop under an active own lease; also required for `claim_project` with `start: true` |
| `profiles:select` | List literal profile names/selection/revision and select an existing profile while stopped |
| `config:write` | Read discovered preset IDs/default/override timeouts and change project-wide timeout overrides for future enqueues |
| `tests:run` | Discover exact worktrees/presets, enqueue finite jobs and read/wait for own credential-bound runs; originating session may cancel |

The owner delegates actions to a stable agent for each registered runtime
project. Each credential has an exact project/action ceiling. Effective access
is their intersection, requiring an active agent, credential, delegation and
stored owner sponsor. Both credential and delegation expiry apply. A sponsor
is derived from the authenticated owner session; callers cannot supply one.
The owner's session may expire without ending durable sponsorship. Revoking the
owner principal blocks sponsored authority. Knowledge grants, DEV vault grants
and remote-verification grants remain independent.
Adding actions to a delegation never widens an existing credential. Issue a new
credential with the intended ceiling; rotation can only preserve or narrow it.
These actions assign no manager role and grant no ENV or secret access.

#### Owner workflow

Run these commands as the installation's OS owner, against the intended data
and state directories. They are examples, not automatic installation changes.
If no owner session exists, `identity bootstrap-owner` creates the first one;
`identity recover-owner` is the protected local OS recovery operation for an
existing owner. Recovery requires the stopped controller's singleton lock.
Save the returned owner session privately. Load it through your secret manager
into `WORKTREE_CONTROL_OWNER_TOKEN`, never as a command-line token argument.
`WORKTREE_CONTROL_TOKEN` is the fallback for older identity commands, but an
installation token cannot authorize these new commands. Open mode ignores
bearer credentials and cannot administer scoped runtime access.

```bash
worktree-control identity bootstrap-owner --label 'Local owner'
```

After bootstrap, load the private owner-token environment variable, then run:

```bash
worktree-control identity create-agent
```

Record the returned principal ID as `AGENT_ID` and the intended
registered runtime project ID as `PROJECT_ID`. Runtime project IDs come from
existing project registration, not Knowledge project IDs. This example assumes
those nonsecret variables are set and creates a delegation with no expiry:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$AGENT_ID" --project-id "$PROJECT_ID" \
  --actions projects:read,claims:manage,runtime:control --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$AGENT_ID" --label 'Private MCP client' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"projects:read\",\"claims:manage\",\"runtime:control\"]}]"
worktree-control identity list-runtime-access --principal-id "$AGENT_ID"
```

`--projects-json` is a JSON array of 1–64 unique project IDs with explicit action
arrays. It supports several projects without combining their scopes. Unknown
fields/actions, repeated flags, missing values and trailing arguments are
rejected. No command accepts a raw token flag or reads scope files. Listing
returns credential metadata, stored ceilings, delegations and current effective
access, never raw tokens. Issuance and rotation print the new raw token once;
only verifiers and nonsecret metadata persist.

There is no default credential or delegation lifetime. Add `--expires-at` with
a future ISO timestamp when a bound is needed. `set-runtime-delegation` replaces
the delegation. At revision `0`, omitting `--expires-at` means no expiry.
For updates/restoration with a later revision, the CLI requires `--expires-at`:
pass the current future timestamp to preserve its bound or `none` to explicitly
remove it. Read `list-runtime-access` before changing actions. The HTTP/service
contract preserves the existing expiry when the field is omitted on an update,
including an already expired bound. Explicit null removes it; omission on creation
means no expiry. Updates and revocations require the current revision.
Revocation retains a tombstone; restoration is a new set with its revision.
Stale mutations fail with a revision conflict (HTTP 409).

#### Private MCP configuration and runtime use

Use the MCP URL configured for this installation. `worktree-control config mcp`
shows its endpoint, but generates compatibility configuration rather than a
scoped credential configuration. In the client's private secret store/config,
replace its authorization header with the once-issued agent token. A template
is shown here; replace both placeholders locally:

```json
{
  "mcpServers": {
    "worktree-control-scoped": {
      "type": "http",
      "url": "<configured MCP endpoint>",
      "headers": { "Authorization": "Bearer <once-issued runtime credential>" }
    }
  }
}
```

Keep the actual configuration and tokens out of repository files, `AGENTS.md`,
`CLAUDE.md`, prompts, chat, logs and issues. The agent receives its own token,
never the owner's session or the installation token.

In that client, call `get_identity` to inspect `runtimeAccess`, then
`list_projects`, `list_worktrees` and `get_project_status`. Use the exact
returned worktree path with `claim_project`, a reason, a stable idempotency key
and an optional TTL of 30–1800 seconds. A scoped claim defaults to `start: false`.
It reserves the worktree without starting or moving the server. Set `start: true`
explicitly when execution is authorized; both `claims:manage` and
`runtime:control` are required. Alternatively acquire without starting and call
`start_project` with the returned project/reservation IDs and a new idempotency
key. `restart_project` and `stop_project` use the same own-lease requirement.
If the previous holder left a server running on another worktree, explicit
`start_project` or `restart_project` stops it and starts the claimed worktree.
`stop_project` stops the project's managed server without changing the selected
worktree or releasing the claim. Every operation still requires current
`runtime:control`; a reservation alone does not authorize runtime changes.
For example, these are MCP tool argument objects, with placeholders replaced
by discovery/claim results:

```json
{
  "projectId": "<registered project UUID>",
  "worktreePath": "<exact discovered path>",
  "reason": "Verify the requested change",
  "idempotencyKey": "verify-claim-1",
  "ttlSeconds": 900,
  "start": true
}
```

Call `claim_project` with that object. To start a previously acquired claim,
call `start_project` with:

```json
{
  "projectId": "<registered project UUID>",
  "reservationId": "<claim result reservation UUID>",
  "idempotencyKey": "verify-start-1"
}
```

Reuse a claim's idempotency key only with the same worktree, reason, TTL and
`start` choice. Conflicting retries are rejected; identical retries keep the
existing renewal deadline. After startup, the controller checks the lease and
all required actions again before reporting success. An expired or released
lease produces a stale-claim error; revoked authority produces a denial.

Check `leaseHeld`, `error` and current safe status after an operation. Release
with `release_project_claim` when finished; release does not stop the server.

These scoped tools omit ENV and profile content editing and foreign lease
details. Logs, cached storage and aggregate capacity need the separate
[diagnostic permissions](#explicit-agent-diagnostics). Finite test admission
requires the separate `tests:run` action. With `projects:read`, agents
can discover/read filtered project and worktree resources, call
`get_project_status_compact` and wait for one project's cursor with
`wait_for_status_change`. The shared waiter budgets apply; sampling, timeout
and delivery after database re-admission recheck current authority. Revocation
rejects pending waits without returning retained data. Cursors cover only the
allowlisted project view and are bound to the credential and MCP session.
Own-run waits require `tests:run`; queue and capacity views need `capacity:read`
and show aggregates only.
The HTTP runtime/dashboard API continues to reject their
credentials, including existing configuration routes; runtime access is through
these MCP tools. No permission grants ENV access.

#### Independent profile and timeout access

An owner can grant either action without discovery, claim or runtime control.
For a new agent whose returned ID is `PROFILE_AGENT_ID`, grant selection only:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$PROFILE_AGENT_ID" --project-id "$PROJECT_ID" \
  --actions profiles:select --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$PROFILE_AGENT_ID" --label 'Profile selection only' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"profiles:select\"]}]"
```

For another new agent, `CONFIG_AGENT_ID`, grant timeout configuration only:

```bash
worktree-control identity set-runtime-delegation \
  --principal-id "$CONFIG_AGENT_ID" --project-id "$PROJECT_ID" \
  --actions config:write --expected-revision 0
worktree-control identity issue-runtime-credential \
  --principal-id "$CONFIG_AGENT_ID" --label 'Preset timeout configuration only' \
  --projects-json "[{\"projectId\":\"$PROJECT_ID\",\"actions\":[\"config:write\"]}]"
```

Use the owner session and private client setup described above. Supply the
registered project ID and, for timeout operations, an exact discovered worktree
path through the task context when the agent lacks `projects:read`. Neither
action implies the other, `claims:manage`, `runtime:control` or a human role.

The [MCP configuration workflow](reservations-and-mcp.md#scoped-configuration-workflow)
defines the four tools, revision handling and claim rules. Profile selection
accepts an exact existing name and never creates, edits, deletes or restarts a
profile. A changed selection requires no owned process or pending cleanup.
When runtime control is separately authorized, use explicit stop, select, start
operations under the own claim. Re-selecting the current profile can be a no-op
while running, but still checks the expected revision.

`config:write` currently means preset timeout overrides only. It cannot change
commands, launch/TLS settings, ENV, literal/test profile content, preset-profile
assignments, identities, global settings or vaults. Both mutations are useful
without a claim, including on verification-only projects. Any active human or
agent reservation blocks them unless the request proves that session's exact
own agent claim. Supplying a stale reservation never falls back to unclaimed
access. A timeout request must target the claim's worktree, even when a claim
acquired with `start: false` left the selected runtime worktree elsewhere.

#### Independently delegated finite verification

Grant `tests:run` explicitly through the protected owner delegation and
credential commands above. None of the other five actions implies it, and it
implies none of them. Adding it to a delegation does not change an existing
credential ceiling; issue a new credential with the intended scope. Agents
cannot issue credentials or approve their own elevation.

Call `list_test_presets` with `projectId`. This action supplies its own safe
exact-path discovery even without `projects:read`. Use a returned `worktreePath`
and preset ID with `run_test`, plus a stable `idempotencyKey`. No command,
arguments, ENV, profile or requester override is accepted. Both `full` and
`compact` response modes return the safe compact envelope for scoped callers.
The existing finite queue executes the job without claiming, starting or moving
a development server.

An unclaimed project needs no lease. An active reservation requires this
session's exact own claim and `reservationId`, with its retained secret and
principal/credential binding. A human lock, foreign claim, stale supplied ID or
worktree mismatch denies enqueue. The original reservation is rechecked during
queued dispatch, immediately before spawn and before an identical retry returns.
Authority is also checked before enqueue, after asynchronous discovery/source
preparation, at dispatch and before spawn. A revoked/expired agent, credential,
delegation or disabled sponsor prevents a new process. Revocation does not
retroactively terminate an already running process.

`tests:run` grants no ENV read or vault use. Human-configured clean test profiles
keep their declared literal variables and fixed system allowlist. Presets that
inherit a server profile are denied until separate ENV-use authority exists.
Nothing reads vault plaintext or changes the signed vault-proof contract.

`get_test_run` and `get_test_run_status` return the same safe envelope. They
require current `tests:run` on the target project and the run's original
principal and credential. A missing, foreign or installation/legacy job returns
the same denial. A new session using the **same credential** may read or wait
for a retained run. A replacement or rotated credential cannot adopt it, even
for the same principal. Supply exactly one `runId` or `projectId` to
`wait_for_status_change`; project waits still require `projects:read`. Run
cursors bind the run, credential and current session and share the existing
sampler, waiter budgets, timeout, cancellation and re-admission checks.

Cancellation remains restricted to the originating MCP session as well as the
original principal/credential and current action. A reconnect that resumes the
same logical session retains this right; initialization of a new logical session
does not. `cancel_test_run` requests cancellation and may return `running` while
owned-process cleanup is pending. Only confirmed cleanup permits a terminal
running-process result. Closing a session disposes waits but does not cancel jobs.
Retained enqueue retries remain scoped to the original session and idempotency
key while detailed records exist; a new session must inspect a known run before
making a new enqueue decision.

Safe envelopes expose only run/project/preset/worktree IDs, phase, timestamps,
exit code, a fixed error code and bounded source HEAD/outcome evidence. They
omit logs, commands, ENV and profile contents/names, actor bindings, foreign IDs,
queue positions, global counts and capacity. Current authority is rechecked for
replayed enqueues and every wait result after database re-admission.

#### Rotate and revoke

```bash
worktree-control identity rotate-runtime-credential --credential-id "$CREDENTIAL_ID"
worktree-control identity revoke-token --credential-id "$REPLACEMENT_CREDENTIAL_ID"
worktree-control identity revoke-runtime-delegation \
  --principal-id "$AGENT_ID" --project-id "$PROJECT_ID" --expected-revision 1
```

Rotation revokes the old credential atomically and prints the replacement once.
Omit `--projects-json` and `--expires-at` to preserve the old ceiling and expiry.
Supply a project/action subset or an earlier future expiry to narrow it.
Rotation cannot add projects/actions or extend a finite expiry. Update the
client's private secret and reconnect; the new session cannot adopt the old
session's claim. Credential-bound vault grants are not copied by rotation.

Revoking a credential, agent or delegation denies the next applicable call,
including retained claim/runtime/configuration receipts and failures. Automatic renewal rechecks
current authority and stops when denied. Existing leases retain their remaining
TTL; revocation does not release the lease or stop its server. Manual renew and
release also require current authority. A replacement session must wait for
expiry or ask a human to review the reservation. Already returned data cannot
be recalled.

#### Explicit agent diagnostics

| Permission | MCP operations | Bounds and exclusions |
| --- | --- | --- |
| `logs:read` | `get_runtime_logs` | One authorized project; last 1..100 retained lines, 4,000 characters per line, under 16 KiB encoded; no disk read or wait |
| `logs:read` plus `tests:run` | `get_test_run_logs` | Same log bounds; exact original principal/credential and current run/project authority; no other run's output |
| `storage:read` | `get_project_storage` | Cached size/status/time plus at most 16 history points for one project/worktree; no scan, arbitrary filesystem read, directory names, content or cleanup |
| `capacity:read` | `get_server_capacity`, `get_test_queue`, corresponding stable resources | Aggregate availability/counts only; no holder, project, run or owner identities |

Every permission is independently grantable. Effective authority is the current
owner-sponsored delegation intersected with the immutable credential ceiling.
Existing credentials receive no backfill; increasing a delegation cannot increase
an issued credential's ceiling. Rotation may only narrow the previous ceiling.
Issue a new credential with explicit consent to add diagnostics. Tool discovery
advertises diagnostic operations allowed at connection time; execution and resource
reads still check current authority. Reconnect after an explicit new grant.

Logs can contain application secrets. The explicit log grant permits that exposure.
The projection redacts known controller credential formats, Authorization/Cookie
fields and controller token environment fields. It does not promise to recognize
arbitrary secrets written by applications. Reads use existing in-memory tails or
bounded stored test tails, so they add no filesystem sampler, timer or long wait.
Capacity uses the existing compact lifecycle projection and queue counters.
No diagnostic permission grants ENV, process control or cache deletion.

#### Upgrade and backup boundary

Schema migration 36 adds delegations, per-credential ceilings and optional
principal/credential lease bindings on the existing SQLite connection. Existing
principal IDs, credentials, Knowledge/vault/remote grants and unbound leases
remain intact. Existing agents receive no runtime backfill. Installation-token,
open and legacy compatibility callers retain their previous broad runtime
authority; scoped credentials do not isolate those callers. Migration 37 adds
the project configuration revision. Existing compatibility configuration
writes increment it alongside scoped changes; no old credential gains actions.
Migration 44 adds immutable test requester attribution on the same connection,
atomically with initial enqueue. It backfills no jobs or credentials. Retention
deletes requester rows with their detailed jobs; full backups preserve them.

Opening an older database with this version applies the pending migrations. Plan an
installation upgrade with a stopped-controller backup and a compatible restore
version; do not use a live database as a test fixture or open it with an older
binary after upgrade. Full backups preserve runtime grants, ceilings and lease
bindings. Restoring an older snapshot can restore older credential/delegation
state; the security fence refuses it until a protected resume quarantines it.

The controller removes its token and keyfile environment variables from managed
process inheritance. Scoped authorization is not an OS sandbox: repository code
still executes with the controller's host identity and its permitted filesystem
access. ENV roles are not implemented.

## Account mode (`better-auth`)

Account mode replaces the shared installation token with individual sign-in for
people and individual credentials for agents. It is optional. Choose it when
more than one person or agent uses the controller and each needs its own,
revocable, per-project permissions.

Switching to account mode changes the browser interface: the dashboard shows a
separate account dashboard (sign-in, **Projects**, **Knowledge** and
**Security**) instead of the token-mode dashboard. Several token-mode
dashboard features are not available there; see
[Account dashboard](#account-dashboard). Review that list before you switch.

### Requirements

| Requirement | How it is checked |
| --- | --- |
| Community `0.2.0` with a current security fence | Startup and `auth fence inspect` (`security_fence_current`) |
| The optional provider, installed from its verified artifact | `auth provider configure` validates the module; startup loads it and checks its contract, storage revision, implementation and Better Auth version |
| A canonical HTTPS origin served by a reverse proxy | Start with `--host 127.0.0.1 --public-url https://…`; the origin must equal the provider configuration. See [Protect the controller with HTTPS](controller-https.md) |
| One active owner principal, enrolled with the provider | `auth provider status --principal-id <owner-id>` and `auth mode set better-auth` |
| A protected owner session for agent administration | `identity bootstrap-owner` (fresh install) or the owner session you already use |

The provider supported by `0.2.0` reports provider contract `5`, storage
revision `3`, implementation `0.0.0-proof.5`, Better Auth `1.7.14` and local
factor reset `v1`. The controller checks the loaded module, not its package
name.

### The optional provider artifact

The provider is a separate MIT-licensed artifact with bundled third-party
notices. It is never an npm dependency of `worktree-control` and is not
published to npm. For `0.2.0` it is attached to the GitHub Release beside the
Community package:

```text
worktree-control-auth-provider-better-auth-proof-0.0.0.tgz
worktree-control-provider-npm-shrinkwrap.json
worktree-control-provider-THIRD_PARTY_NOTICES.md
worktree-control-provider-LICENSE
worktree-control-provider-INSTALL.md
worktree-control-provider-SHA256SUMS
worktree-control-provider-provenance.json
```

The package keeps its historical name
`@worktree-control/auth-provider-better-auth-proof` and package version `0.0.0`,
because the controller and existing configurations reference that module and
its implementation `0.0.0-proof.5`. The name does not describe its status.
Identify the exact artifact by `worktree-control-provider-provenance.json`: `compatibleCore.version` must
be `0.2.0`, `source.commit` must be the release commit with `source.dirty:
false`, `provider.implementationVersion` must be `0.0.0-proof.5`, and
`artifact.sha256` must match `worktree-control-provider-SHA256SUMS`.

Download all seven provider assets into one directory for checksum verification.
Install it into its own private directory. `npm ci` installs exactly the
shipped lock; do not use `npm install <tarball>`, which ignores the shipped
`npm-shrinkwrap.json` and resolves newer transitive versions than the ones
tested. Use a private umask: the controller refuses a module that other users
can modify.

```bash
sha256sum --check worktree-control-provider-SHA256SUMS
umask 077
PROVIDER_DIR="$HOME/.local/lib/worktree-control-provider-0.2.0"
mkdir -p "$(dirname "$PROVIDER_DIR")"
mkdir "$PROVIDER_DIR"
tar -xzf worktree-control-auth-provider-better-auth-proof-0.0.0.tgz \
  -C "$PROVIDER_DIR" --strip-components=1 --no-same-owner
npm ci --prefix "$PROVIDER_DIR" --omit=dev --ignore-scripts
ls "$PROVIDER_DIR/dist/index.js"
```

`npm ci` needs registry access. The module path for configuration is
`$PROVIDER_DIR/dist/index.js`. Keep the directory and the verified artifact for
recovery. The directory name above is an example; any private path outside Git
working trees works.

### Choose OS accounts for agents

Account mode authorizes requests that arrive over HTTP and MCP. It does not
separate processes that run as the controller's OS user. Such a process can
use the private admin socket, the protected CLI and the user service manager,
and it can read the state directory and the database. It can register or
remove projects and change the authentication mode without an agent
credential.

Run agents under a different OS account or in a sandbox that cannot reach the
controller's data and state directories, its admin socket or its service
manager. These agents use the MCP or HTTP endpoint with their own credential.
Give them access to the repositories through a group or ACLs. Keep the
controller and the repositories under the operator's account.

If agents share the controller's OS user, RBAC still limits what agents do
through MCP and HTTP. Use that setup only when you trust every agent process
as the operator.

### Turn on account mode

Run these steps as the installation's OS user, with the controller stopped, on
the same data and state directories the controller uses. Pass the same
`--data-dir` and `--state-dir` to every command if you use custom paths.
Passwords and signing material enter only through a private file or a pipe,
never arguments, environment variables, chat, Git or Knowledge.

1. **Stop the controller and back it up.** `worktree-control service stop` (or
   stop the foreground process), then
   `worktree-control backup create <new-private-directory>`.
2. **Check the fence.** `worktree-control auth fence inspect` must report
   `security_fence_current`. An upgraded `0.1.1` installation first needs the
   [upgrade procedure](package-trial.md#upgrade-from-011-to-020).
3. **Find the owner.** `worktree-control auth provider status` reports the owner
   state. Use the existing active owner's principal ID throughout. On a fresh
   installation without an owner, run `worktree-control identity bootstrap-owner`
   and save the printed owner session privately. Never create a second owner on
   an existing installation.
4. **Install the provider** as shown above.
5. **Configure the provider.** Write a private JSON file (mode `0600`, outside
   any Git working tree), then:

   ```json
   {"module":"/home/me/.local/lib/worktree-control-provider-0.2.0/dist/index.js","origin":"https://controller.example","signingSecret":{"kind":"generate"}}
   ```

   ```bash
   worktree-control auth provider configure --input-file /private/provider.json
   ```

   The origin is the HTTPS address users open. `generate` creates the signing
   secret once; see [Protected provider maintenance](#protected-provider-maintenance)
   for later changes and for backing up `authentication-provider.json`.
6. **Enroll the owner.** Write `{"email":"…","name":"…","password":"…"}` to a
   private file (password 12–256 characters), then:

   ```bash
   worktree-control auth provider enroll --principal-id <owner-id> --input-file /private/enroll.json
   ```

   Delete the file afterwards. The owner keeps its ID, kind, grants and history.
7. **Grant access explicitly.** Nothing is granted by default, not even to the
   owner. Give each person runtime and Knowledge permissions with
   [human accounts](#ordinary-humans-and-knowledge-memberships-a3-i24) and
   [human runtime access](#human-runtime-access). Give each agent its own
   [scoped runtime credential](#scoped-runtime-agents-a2) and Knowledge grant.
   The installation token stops working in account mode.
8. **Select the mode.** `worktree-control auth mode set better-auth`. It loads
   the provider and refuses unless configuration, owner enrollment and the fence
   are ready.
9. **Start with the HTTPS origin.** The controller must run with
   `--host 127.0.0.1 --public-url <origin>` behind the reverse proxy; for the
   user service, follow the refresh step in
   [Protect the controller with HTTPS](controller-https.md). Without a matching
   `--public-url`, startup refuses with
   `Account authentication requires a canonical HTTPS --public-url.`
10. **Verify.** `auth status` reports `activeMode: better-auth`. Sign in at the
    origin, check each person's projects, connect each agent with its own
    credential and confirm the old installation token gets `401`.

A failed start leaves the selection in place. Fix the reported requirement, or
choose another mode explicitly (see [Leave account mode](#leave-account-mode)).

### Transport contract

| Entry point in active RBAC | Application enforcement |
| --- | --- |
| HTTP `/api/auth/*` allowlist | `AuthenticationHttp` and provider runtime validate canonical Host/Origin, strict JSON, bounded bodies, socket peer, secure cookies and committed session evidence |
| Cookie `/api/knowledge` | `ProviderKnowledgeApplication` rechecks current session and explicit Knowledge membership/grants |
| Cookie `/api/runtime/read` | `ProviderRuntimeReadApplication` and shared runtime reads require explicit `projects:read` |
| Cookie `/api/runtime/mutate` | `HumanRuntimeService` requires the original current session, membership revision and exact human lease for each effect/receipt |
| Cookie `/api/runtime/tests` | `HumanVerificationService` requires independent `tests:run`, original attribution and dispatch/delivery rechecks |
| Cookie `/api/runtime/configuration` | `HumanConfigurationService` requires explicit profile/timeout permission, original authority and atomic revision checks |
| Agent HTTP Knowledge and online Knowledge CLI | Individual agent credential, current principal and resource grants in `IdentityService` and `KnowledgeService` |
| Agent MCP tools/resources | Per-request bearer resolution, session binding and shared Knowledge/runtime/configuration/verification policy; retained results reauthorize |
| Agent remote verification | Existing submitter/project and worker/project/preset checks remain independent |
| Agent DEV vault | Existing explicit vault grants and separate Ed25519 owner proof remain required |
| Public identity bootstrap/admin, broad dashboard/runtime API, directories, ENV, TLS and storage cleanup | Denied before effects; cookies and machine tokens gain no installation authority |
| Cookie downloads/attachments/exports, SSE, Godot preview, backups/restore and schedules | Unsupported and denied; use converted operations or protected operator workflows |
| Agent attachments/exports/schedules | Only existing explicit Knowledge permissions and resource checks; no runtime right implies them |
| Protected Unix admin socket | OS owner channel; provider/mode maintenance, project registration and current-owner identity administration on the same store |
| Protected stopped CLI and recovery | Both singleton locks, current owner credential where required, protected fence preflight and existing recovery operations |
| Static dashboard assets | Public static export; no private data or controller authority |

Shared installation tokens, legacy pairing links and legacy MCP secrets confer
no authority in RBAC, including a request carrying both old product-token headers
and an individual bearer/cookie. Owner-session bearers remain available only to
protected local administration; they cannot bypass public account sessions.
Unknown actions/resource substitutions deny. Token rotation and principal,
credential, session, role and delegation revocation remain immediate. Converted
operations retain their existing admission, wait, dispatch and delivery checks.
Selecting the next boot's mode never changes the running boot's authority.

`identity` commands on an active RBAC controller use its private admin socket and
require a current owner credential. They invoke the same identity application
operations as offline administration. No second database connection is opened.
This supports explicit issue/rotate/revoke without a restart or a public owner
bootstrap route. `identity recover-owner` remains a stopped-controller operation.
Provider password/factor recovery uses the existing protected provider commands.

### Protected provider maintenance

The protected local commands are:

```text
auth provider status [--principal-id ID]
auth provider configure --input-stdin
auth provider owner create
auth provider human create
auth provider human list [--limit 1..20] [--after ID]
auth provider human disable --principal-id ID
auth provider knowledge-access list --principal-id ID [--limit 1..20] [--after PROJECT_ID]
auth provider knowledge-access set --input-stdin
auth provider knowledge-access revoke --input-stdin
auth provider enroll --principal-id ID --input-stdin
auth provider recover --principal-id ID --input-stdin
auth provider runtime-access list --principal-id ID [--limit 1..20] [--after PROJECT_ID]
auth provider runtime-access set --input-stdin
auth provider runtime-access revoke --input-stdin
```

Each command also accepts `--data-dir` and `--state-dir` once. Sensitive
commands also accept `--input-file ABSOLUTE_PATH` instead of stdin.
Input is exactly one strict UTF-8 JSON object, at most 8 KiB; stdin has a
ten-second deadline and refuses an interactive terminal, so pipe the input.
Files must be regular, current-user-owned, single-linked,
private (no group/other access), outside Git working trees and supervised
repositories, with no symlink components. Unknown or repeated flags and extra
JSON fields are refused. Passwords
and signing material have no argument or environment option. Use a private pipe
or file; keep secrets out of shell history.

Configure input has exactly `module`, `origin`, and `signingSecret`. The module
is an absolute local JavaScript path or file URL, without a symlink entry, query
or fragment. It is trusted in-process code owned by the operator or system and
not writable by others. Origin must be HTTPS without credentials, non-root path,
query or fragment. The core fixes `/api/auth` and its internal client-IP header.
This nonsecret example shows the structure:

```json
{"module":"/protected/provider/index.js","origin":"https://controller.example","signingSecret":{"kind":"generate"}}
```

Only explicit initial `generate` creates 32 random bytes. Alternatively supply
`{"kind":"supplied","value":"<canonical base64url material>"}` with 32–128
bytes from a cryptographically secure generator. Format and length cannot prove
entropy; the operator must supply randomness. Later configuration requires
`{"kind":"preserve"}` or exactly the existing supplied value. There is no
rotation/delete command. Existing provider data with missing configuration
requires restoring the original material, never generation. Invalid existing
configuration refuses maintenance. If only the old provider module has moved or
disappeared, protected configuration can select a validated replacement while
preserving the exact signing material. Reading/loading still validates the
selected module; replacement never bypasses private-file, document or secret checks.

Private `authentication-provider.json` in the data directory is the durable
authority. File fsync, rename and directory fsync publish it. Uncertainty before
or after rename returns `configuration_write_unconfirmed`; inspect private status
before another intentional command. Configuration emits a fixed nonsecret
operational event (stderr for stopped CLI, controller log online), without
claiming atomic SQLite/filesystem audit. Back up the
file separately under protected custody. SQLite snapshots and Knowledge/user
exports do not include it. A restored database is refused by the
[security fence](#external-security-fence-and-protected-resume-p3b) until a
protected resume removes restored passwords and sessions.

`owner create` writes one stable active owner and ID-only transactional audit,
with no credential, token, role or grant. Any existing owner, including revoked,
prevents creation. Status reports none/single/ambiguous; existing installations
choose an active ID explicitly. Enrollment input is exactly `{email,name,password}`;
recovery input is `{newPassword,factors?}`, where `factors` is `"preserve"` or
`"reset"` and omission preserves selected factors. Passwords must be 12–256 characters;
this is an engineering bound, not an approved password policy. Email never selects an identity.
Principal creation and enrollment are separate transactions. Failed enrollment
leaves a harmless uncredentialed principal for inspection and explicit retry.
Any mapping history, including revoked, prevents re-enrollment.

Recovery checks the exact active owner or human and mapping inside the actual
queued borrow and again after hashing and at transaction entry. It atomically
replaces the password, deletes every subject session and audits. Explicit factor
loss reset also removes factor bindings and advances generation as described
[below](#protected-factor-loss-recovery-p3a).
It preserves principal/provider IDs, authorization grants/bindings and tombstones. Revoked
principals/mappings are not reactivated. Session revocation is immediate despite
a pending next-start mode selection.

Online commands use the existing owner-only Unix socket and store. Configure,
status, principal creation, human lists/disable and membership commands do not
import provider code. The first explicit enroll or
recover loads one retained runtime; concurrent commands share initialization.
Changed loaded configuration blocks account mutations until a new owner boot.
Status omits secrets, paths, email and provider subjects/sessions. `ready` means
maintenance initialized only. There is no hot reload, mode fallback,
compatibility bearer or default grant. Public login exists only in a controller
that started in account mode.

Stopped commands acquire both owners and start no listeners. Success is printed
only after provider disposal/drain, SQLite close and lock release. Unconfirmed
cleanup reports `cleanupConfirmed:false` and retains the actual process, resources
and locks for operator recovery. There is no forced exit or recovery daemon.
Real process death permits stale-PID lock recovery, but does not prove cleanup
of arbitrary external effects from trusted module code.

Errors are fixed structured DTOs; no effect is automatically replayed.
`committed:true` preserves a known committed effect despite notification/cleanup
failure. Its absence does not imply rollback. After a lost enrollment response,
inspect principal enrollment status. Recovery has no durable receipt; after a
lost response its outcome is unknown. Another intentional recovery is a new
password/revoke-all effect, including sessions created since the first.
Same-OS-user agents share operator authority. Host isolation and delegated
account administration are not provided.


### Ordinary humans and Knowledge memberships (A3-I24)

The protected operator can create an ordinary `human`, enroll it separately with
`{email,name,password}`, and assign reader/operator access to a typed Knowledge
project. Creation writes only a stable principal and audit. It creates no provider
account, compatibility credential, grant or role. Historical `owner` rows retain
their IDs, kinds, credentials and first-owner semantics. Human account lists use
keyset pagination with a default and maximum of 20; `nextAfter` selects the next
page. Status/list DTOs contain no email, native subject/session or credential data.

```bash
worktree-control auth provider human create
worktree-control auth provider enroll --principal-id <human-id> --input-file /private/enroll-human.json
worktree-control auth provider knowledge-access set --input-file /private/knowledge-access.json
worktree-control auth provider human list --limit 20
worktree-control auth provider human disable --principal-id <human-id>
```

Membership set input is strict JSON through the same private pipe/file handling:

```json
{"principalId":"H1","scope":{"kind":"knowledge-project","id":"K1"},"role":"reader","permissions":["knowledge:read"],"expectedRevision":0}
```

Revoke input has exactly `principalId`, `scope` and `expectedRevision`.
Only `knowledge:read` and `knowledge:write` are accepted. A role is a ceiling:
reader plus an explicit write grant still cannot write; operator plus a read-only
grant cannot write either. Every human operation requires both an active grant
and an active explicit reader/operator binding. A role alone grants nothing.
Attachments, export/import, logs and approval remain denied for ordinary humans,
even if broader stored grants exist. The legacy optional-binding rule remains
for existing owners and agents.

Binding revision is the membership aggregate revision. `0` means never assigned.
Set writes the full explicit grant, binding, incremented revision and audit in one
immediate transaction. Permission-only changes also increment it. Revoke tombstones
both rows atomically. Restore requires a complete new set with the tombstone's
latest revision. A stale set/revoke conflicts without an effect or success audit.
The old identity grant/role setters and revokers refuse human targets, including
direct calls to their storage methods. Read the current private list after an
unknown result before deciding on a new command; no command is replayed automatically.

`knowledge:write` retains A1 project archive/restore semantics. Linking,
re-pointing and unlinking a runtime project additionally require the owner or
the current installation, in open and token mode alike. Agents, workers and
ordinary humans are refused even with `knowledge:write`. The shared service
refuses before runtime lookup or retained replay, giving the same safe denial
for known and unknown runtime IDs.
Reading an existing linked ID is navigation metadata and grants no runtime access.

Disable performs a conditional active-to-revoked transition plus audit. It is
terminal; a repeat returns `changed:false` with the revoked state and adds no
success event. There is no reenable, deletion or kind-change command. The current
principal state denies the next Knowledge operation or replay independently of
invalidation notifications. The disable transaction also deletes at most one native
session for that human, cascading its evidence and issuance marker. The shared protected
application drains the remaining sessions one row per freshly admitted transaction,
including revoked mapping history, without loading the provider. This recovers existing
global capacity without adding a per-account cap. An interruption leaves revocation
committed and reports `committed:true`; repeat disable to resume cleanup. Retained rows
still count until deleted. Other principals' sessions remain untouched. Enrollment checks active kind and
mapping history in the actual borrow and again at the final link after password
hashing; a prior committed disable prevents native account publication.

Private IPC and offline CLI call the same application and store operations.
Human commands use the trusted local bootstrap context; request actor/kind/sponsor/
strength fields confer no authority. Ordinary human cookies cannot administer
accounts/members, create agents, sponsor credentials, operate runtimes/claims,
approve Knowledge, access ENV/vault, or administer backups/remote workers.
Protected recovery supports existing active owners and humans. Explicit local factor-loss
reset is described below; browser factor removal and invitations remain unsupported. Current-session password changes and optional
TOTP/passkey protection retain their existing rules.


### Human runtime access

Protected `runtime-access` commands give a person explicit permissions on one
registered runtime project. There is no default project access, including for
the owner. Knowledge memberships confer no runtime access, and runtime
membership confers no Knowledge rights.

```bash
worktree-control auth provider runtime-access list --principal-id <human-or-owner-id> --limit 20
worktree-control auth provider runtime-access set --input-file /private/runtime-access.json
worktree-control auth provider runtime-access revoke --input-stdin
```

Set input contains the full aggregate. `reader` takes exactly
`["projects:read"]`. `operator` takes a nonempty, unique explicit subset of
`projects:read`, `claims:manage`, `runtime:control`, `tests:run`,
`profiles:select` and `config:write`; the role implies none of them.

```json
{"principalId":"HUMAN_ID","scope":{"kind":"runtime-project","id":"PROJECT_ID"},"role":"operator","permissions":["projects:read","claims:manage","runtime:control"],"expectedRevision":0}
```

Revoke takes `principalId`, `scope` and `expectedRevision`. Every change uses
the current revision (`0` for the first assignment), commits with its audit
atomically and keeps a tombstone on revocation; a stale revision conflicts.
Lists use `--limit` from 1 to 20 and `--after <project-id>`, returning
`nextAfter`.

| Permission | What the person can do in the account dashboard |
| --- | --- |
| `projects:read` | See the project, its status and discovered worktrees |
| `claims:manage` | Claim, renew and release their own reservation (TTL 30–1800 s, default 1800; capped by the session and an eight-hour maximum) |
| `runtime:control` | Start, restart and stop under their own claim, and claim with start |
| `tests:run` | List presets, run finite tests and read, wait for or cancel runs from the same session |
| `profiles:select` | Select an existing literal environment profile while the server is stopped |
| `config:write` | Set or clear preset timeout overrides for future runs |

A human claim is bound to the session that made it. A new sign-in, a
revocation or a regrant cannot take over an existing claim or test run; release
or wait for expiry instead. Expiry and revocation do not stop a process that was
already started. Human accounts have no log, storage or capacity diagnostics,
ENV, vault, backup or administration permissions.

### Account dashboard

The dashboard asks `GET /api/auth/status` which mode is active. In account mode
it shows the account dashboard; only an unambiguous answer selects a surface,
and a failed probe shows a retry state rather than the token dashboard.

- **Sign-in** with email and password, then a TOTP code or a passkey when the
  account selected one, or directly with a passkey.
- **Projects:** the permissions above, shown and enforced per project. The
  dashboard never infers rights from the owner label; denials come from the
  server and are shown as such.
- **Knowledge:** tasks, discussions and memory within the person's Knowledge
  membership.
- **Security:** change password, enable TOTP, register a passkey (two steps:
  create, then confirm). Enabling a method ends every session of the account,
  including the current one.
- **Sign-out** completes only when the server confirms it. If confirmation does
  not arrive, account data stays hidden behind an unconfirmed state with a
  manual retry.

The HttpOnly session cookie is the only browser authority. No password, token
or CSRF value reaches the URL, web storage or logs. A non-secret marker
(`worktree-control.signOutUnconfirmed`) in web storage keeps an unconfirmed
sign-out across a reload; it is never authority.

Not available in account mode: Knowledge attachments and exports, live updates
(server-sent events), downloads, ENV and DEV vault administration, backups,
schedules, project registration and settings, Godot Web preview, and the broad
token-mode dashboard views. They are shown as unavailable or hidden, never
silently retried. The dashboard creates no owner and offers no signup,
invitation or recovery; those stay with the protected CLI.

Known limits accepted for `0.2.0`:

- Only the Projects tab polls (while visible). The Knowledge and Security tabs
  make no automatic request, so after a sign-out, expiry or revocation elsewhere
  their last view, including private Knowledge content, stays on screen until
  the next interaction answers `401`. Close account tabs on a shared browser.
- Another open tab learns of a sign-out only on its next request; tabs do not
  watch each other.
- The configuration panel's reload after a save is not bound to the latest
  request or worktree. An older answer can briefly replace a newer view, and a
  double-clicked save can report `revision_conflict` although the first write
  succeeded. The server's revision check rejects stale writes; the conflict
  reload shows current values.
- If web storage is unavailable, a reload cannot recover an unconfirmed
  sign-out intent; the current page still blocks account data.
- The test runs list covers only runs started in the current session and is
  not restored after sign-in.
- Passkeys were verified with a virtual authenticator in Chromium. No hardware
  authenticator or manual visual QA was performed for this release.

### Optional TOTP and passkeys

Each account chooses its protection. A password-only account stays possible.
Once an account selects TOTP, a passkey or both, a password alone no longer
signs in; with both selected, either one is enough. Enrollment grants no role
or permission.

Engineering bounds in `0.2.0`: five TOTP and ten passkey evaluations per
account per minute, a 15-second evaluation ticket and a ten-minute enrollment
window; native limits may refuse sooner. Anonymous passkey options have
per-peer/global limits of 20/120 per minute, 128 peers, 4,096 challenge rows and
64 completion reservations. A used TOTP step cannot be replayed, and failed
guesses are charged durably. Behind a reverse proxy all clients share the
proxy's peer address for per-peer limits. These are capacity and guessing
bounds, not an ASVS or other compliance claim.

Not supported, and refused: recovery codes, TOTP or passkey replacement and
removal in the browser, additional passkeys, reauthentication prompts and
trusted devices. A lost factor is reset only by the protected
[factor-loss recovery](#protected-factor-loss-recovery-p3a).

### Leave account mode

Leaving account mode is an explicit operator decision to give up individual
isolation. Stop the controller. If no installation token exists, run
`worktree-control auth token generate` and save it. Then run
`worktree-control auth mode set token` and start the controller. Individual
agent credentials keep working in token mode.

If the provider is lost or broken, the controller refuses to start in account
mode. Restore the provider directory and the separately backed-up
`authentication-provider.json`, or choose token mode as above. There is no
automatic fallback.

### Protected factor-loss recovery (P3a)

The protected CLI `auth provider recover --principal-id <id>` accepts a private
JSON input file or stdin containing `newPassword` and optional `factors`.
Omit `factors`, or choose `"preserve"`, to retain selected protection. Choose
`"reset"` only when intentionally removing every TOTP and passkey binding for
that account. The new password is always required. Never put it in argv.

Recovery applies to an existing active human or the single active owner with an
exact active provider mapping. Disabled accounts, revoked mappings, missing
enrollment, agents, workers and ambiguous owners refuse. It preserves principal
ID, kind, memberships, sponsorship and historical audit. It issues no browser
cookie, bearer, machine credential or additional permission.

The configured real provider advertises readiness `localFactorReset: "v1"` and a
separate `recoverLocalWithFactorReset` method under contract 5/storage revision 3.
Both are required before a reset can write. Older password-only implementations
remain loadable and refuse explicit reset. Status does not load provider code;
its recovery field reports whether the loaded runtime supports reset.

One transaction on the controller connection replaces the password, deletes old
sessions and evidence, advances account generation and policy revision, removes
native TOTP/passkey rows and their trust/staging bindings, and invalidates the
account's pending contexts and charged receipts. Subject-bound native challenges
are deleted. Anonymous options cannot authenticate a removed key. TOTP replay
steps, account budgets, receipt history and audit remain; reset never refunds a
failed guess. Safe output reports native TOTP and passkey rows removed, including staged passkeys.
A reset with no factors still advances the generation and succeeds.

Current mapping/principal and maintenance/configuration are checked again after
hashing and before commit. A rollback retains old state. A notification error
after commit reports `committed:true`; do not automatically repeat recovery after
an uncertain or lost response. Fresh login uses the same principal and current
original grants. Optional enrollment creates a new factor binding.

Only the existing OS-protected Unix administration channel and offline singleton
owner path authorize this operation. HTTP, MCP, browser sessions, shared tokens
and agent credentials cannot request it. An agent running as the controller OS
user remains trusted by that boundary. The independent signed vault proof is
unchanged. A restored or unconfirmed database refuses provider loading until
the protected resume below.

## External security fence and protected resume (P3b)

Migration 49 adds one `security_checkpoint` row and fixed triggers over the
provider, identity, grant, policy, encrypted vault and durable execution authority
tables. Migrations 1 through 48 and their checksums are unchanged. Each covered
write changes a 256-bit checkpoint nonce inside its own transaction. The
installation nonce stays fixed. Trigger definitions, required tables and row
shape are recognized before writable PRAGMAs or migration effects.

The witness is `<canonical-database-path>.security/witness.json`. This private
sibling directory is outside the application backup payload, which contains only
SQLite, its manifest and referenced attachment objects. It is derived from the
canonical database path even with custom `--data-dir`/`--state-dir`; nesting the
state directory under data does not move the trust boundary. Restore refuses
attachment targets overlapping the witness directory. Never include this witness
in a restore of application data. Copying an installation to a new path needs
explicit protected resume and quarantine.

The OS owner and the private path ancestry are trusted. This design detects
DB-only rollback, missing/corrupt/stale/wrong-installation witnesses, and supported
restore. It cannot detect rollback of the whole host or a manually copied trust
domain containing both the matching SQLite and witness. There is no off-host
anchor. A pre-upgrade database copied without its witness is indistinguishable
from a store that was never upgraded: establishing it could revive credentials
revoked since that copy. Establish only an installation you have never already
upgraded. Recover with `backup restore` and protected resume; never replace the
data directory with a pre-upgrade plain copy. Checksums detect corruption; they do not defend against the trusted OS
owner replacing both sides.

The strict checksummed witness is bounded to 4 KiB. Its directory admits at most
32 named witness/publication files. Existing files require private ownership and
permissions, no symlink/hardlink aliases and descriptor identity checks; recovery
does not repair unsafe permissions into trust. The record binds canonical paths,
installation/checkpoint, database device/inode, configured mode/generation, owner identity, acknowledged
restore operation and protected recovery receipt. It contains no tokens, password
hashes, factor material, vault keys or signing secrets.

### Protected operator workflow

Use the installed compatible CLI with the controller stopped. The commands
acquire both the state-directory singleton and canonical database-owner lock;
they have no HTTP, MCP, shared-token or public provider equivalent and never
start a server. A running owner causes refusal instead of an online fallback.
For custom paths, pass the same `--data-dir` and `--state-dir` on every command.

```sh
worktree-control auth fence inspect --data-dir /private/installation
worktree-control auth fence establish --expect <preflight-hash> --backup-dir /private/backups --data-dir /private/installation
```

Establishment is permitted only for a recognized existing pre-fence store without
external witness or restore evidence. Inspect and preserve a verified application
backup before this explicit adoption. On the integration branch `--backup-dir`
is required (one non-blank directory, made absolute; refused for `inspect` and
`resume`): establishment first writes `pre-establishment-v<source schema>-<UUID>`
there and accepts it only as this run's copy of this source, then migrates the
structure to schema 52 with the upgrade marker `pending`. A fence already trusted
returns at once with `changed: false`, takes no backup and writes nothing to the
directory. Every fence result carries `nextStep`: `auth fence establish` or
`auth fence resume` while the fence is not trusted, and `upgrade inspect` once
it is, after a successful establish or resume and for the no-op alike. A trusted
fence is not yet an ordinary start: the upgrade runs first. A fresh database uses its verified creation
marker; a missing witness on an established database is never first boot.

For restore, stale/missing/corrupt witness or uncertain publication, inspect again,
then explicitly choose the resumed mode:

```sh
worktree-control auth fence inspect --data-dir /private/installation
worktree-control auth fence resume --expect <preflight-hash> --mode token --data-dir /private/installation
```

An unclean stop needs the same resume. In an owner, every transaction that writes a fenced
table publishes a pending witness before SQLite changes its first such row and
confirms it only after the commit. A controller killed, crashed or powered off
between the two leaves the witness pending, whether SQLite then rolls the write
back or has already committed it. Every ordinary opening refuses a pending
witness with `security_fence_recovery_required`; nothing confirms it
automatically. A commit whose outcome the live process cannot prove (a lost
commit acknowledgment) fails the fence in that process: it refuses further work
with `security_fence_pending`, and its next start is refused in the same way.
Ordinary operation writes fenced tables often: sign-in, password change and the
recovery of issued sessions (native sessions, evidence and issuance markers),
factor verification (TOTP steps, budgets and receipts), each bearer-token
authentication (`principal_credentials.last_used_at`), each test run's queueing
and phase changes (`test_runs`), claims, renewals, releases and expiry
(`reservations`, `human_runtime_leases`), and remote-worker contact and
verification attempts. After such a stop the operator runs `auth fence inspect`,
`auth fence resume` and the upgrade, and the resume costs what it costs after a
restore: all sessions, provider passwords, TOTP and passkey bindings, machine
credentials, the installation token and grants are removed. Owners then recover
their passwords, and tokens and grants are issued again.

Resume first publishes a pending receipt. One sole-connection transaction applies
any pending schema steps and, in the same commit, removes
all restored provider passwords/tokens, native sessions, TOTP/passkeys and
challenge authority; revokes principal credentials and all project/role/runtime
and worker grants; advances account generations and membership revisions; releases
leases; interrupts pending finite jobs with the existing truthful writer; and
cancels pending remote work. Foreign keys are off in that transaction, so it
deletes the dependents of what it removes itself: session evidence and issuance
markers, passkey trust and staged passkeys, and the requester rows of the
detailed jobs that retention trims. It retains IDs, kinds, roles, membership rows, audit,
run/intention attribution, TOTP steps, budgets and encrypted vault content.
The same existing owner is preserved, and a readable external owner anchor must
match. No owner, credential, project permission or ENV grant is created.

No committed state has the current schema with the restored authority still
intact. A failure before that commit leaves the schema and the authority as they
were. A failure after it reports `committed:true`; the transaction's
`authentication.security_quarantined` audit event carries the run's receipt and
proves the commit even when the schema version did not change.

Only after quarantine and handoff acknowledgement does the owner publish the
confirmed receipt. Repeated resume on that unchanged confirmed state is a no-op.
A crash during recovery remains fenced; repeating explicit recovery can only
quarantine again. The journal and restore-request history are never deleted or
reclassified. Raw rollback after a successful receipt is fenced again.

In token mode, issue a fresh token through the protected existing command. For
accounts, restore the separate private provider configuration and use P3a
`auth provider recover` with a private new-password input for the existing active
owner or chosen human. Reissue machine credentials and regrant access explicitly.
Ordinary P3a password recovery still preserves selected factors by default.
`--mode open` is an explicit loss of account isolation. `--mode better-auth`
records account mode for the next start, which still requires the provider
configuration, an enrolled active owner (recover its password first) and a
matching `--public-url`; there is no fallback.

The receipt adds a generation/time floor to `controllerRestoreBoundary` for
schedules and encrypted vault grants/receipts. The existing Ed25519 owner proof,
strict proof/grant `createdAt` checks, credential binding and encrypted state
remain required. Recovery neither substitutes a provider session for that proof
nor revives a previous vault grant. Process cleanup continues through existing
verified owned-process shutdown; recovery never infers ownership from an occupied
port and never reauthorizes old pending work.

Neutral fixed errors distinguish `security_fence_establishment_required`,
`security_fence_recovery_required`, `security_fence_pending` and
`security_fence_preflight_changed`. A running owner returns `security_fence_owner_running`. Status and errors expose no credential material.
On the integration branch, `auth fence establish --backup-dir` refuses a backup
that fails, does not validate or is not this run's copy with
`security_fence_backup_failed`: nothing was changed and no witness was written;
inspect, then establish again.
Tests cover raw/supported rollback, native provider recovery, corrupt/missing
witnesses, filesystem synchronization faults, SQL rollback, idle rechecks and
real child-process crashes. See the historical implementation reference for
the detailed test boundaries.

### After an unclean stop or a storage failure

This section is for the person who operates an installation. It explains why a
controller can refuse to start after it was killed, how likely that is, and
what the way out costs.

Every write to a table the fence protects publishes a witness marked pending
before the row changes. After the commit it publishes a confirmed witness.
Such writes are routine. Each authentication with an agent or owner credential
writes one, because it records when the credential was last used. So do each
saved test run, claims and their renewals, sign-in and sessions in account
mode, remote-worker contact and settings. The check of the installation token in
`token` mode writes nothing protected.

If the controller is stopped in a way it cannot catch between the two
publications, the next start is refused with `security_fence_recovery_required`.
The stops it cannot catch are `SIGKILL`, the kernel's out-of-memory killer,
power loss, a kernel crash, and the service manager killing the process after
its stop timeout (the generated systemd unit uses `TimeoutStopSec=15`). An
ordinary stop is safe: `SIGTERM`, or a `systemctl stop` that finishes in time.
The controller finishes the write and its confirmation first. Tests cover this.

How long the gap lasts was measured on one host, with 200 samples per case. It
is about 5 milliseconds per protected write on an ext4 disk. The medians were
4.6 ms for an authentication with a credential and 5.6 ms for a saved test run,
and single samples reached 14 ms. On tmpfs it is under 1.2 ms. The next figure
is an estimate, not a measurement. An installation that handles 30 credential
authentications and 12 test-run saves a minute spends about 0.3% of its time
inside the gap, so roughly one uncatchable stop in 300 would land there. Stops
caused by memory pressure during heavy test activity are more likely to land
there than a stop at a random moment. A slower or busier disk lengthens the
gap.

The only supported way out of a refused start is `auth fence inspect`, then
`auth fence resume --expect <preflight> --mode <token|open|better-auth>` with
the controller stopped. The steps are in
[Protected operator workflow](#protected-operator-workflow). Resume keeps
accounts, principals, history and audit, but it removes authority:

- credentials and all grants, roles, delegations and memberships stay as
  records but are revoked;
- provider passwords and tokens are cleared;
- sessions, verification challenges, TOTP and passkey bindings are deleted;
- the installation token is removed;
- claims are released;
- running test runs are marked interrupted.

On this unreleased integration build, resume is not the last step. After it,
the start and every offline `auth`, `auth provider` and `identity` command are
refused with `upgrade_required` until the explicit upgrade has run. The order
is: resume, `upgrade inspect`, `upgrade apply`, then credentials and grants,
as in
[The explicit upgrade (unreleased integration build)](#the-explicit-upgrade-unreleased-integration-build).
Do not issue credentials or grants before the apply: it revokes them.

Afterwards nobody has access until it is set up again. In `token` mode, create
a new installation token, reconfigure every client and issue agent credentials
again. New credentials reach no project by themselves: recreate the project
grants, roles, delegations and memberships that resume revoked. In account
mode, users cannot set a password themselves, because passwords and sessions
are gone. Restore the provider configuration first. Then the owner runs
`auth provider recover` from the CLI for the owner account and for each human
that should return, as described in
[Protected operator workflow](#protected-operator-workflow), and each of them
enrols a second factor again.

A storage failure while the controller runs, such as no space left or an I/O
error, can strike during one of these publications. It does not stop the
process. From then on that process refuses every protected write and every
protected read with `security_fence_pending`, also after space is free again.
No caller is told that a write succeeded when its confirmation was not
published. Restart the controller. What the restart finds depends on where the
failure struck. If it struck before the pending witness was in place, which is
the usual case when the disk is already full, nothing was changed and the start
is admitted. If it struck after the pending witness was in place, the start is
refused as described above and needs the resume, even when the row change
itself was rolled back. This was tested with injected errors, not with a really
full disk.

To reduce the risk:

- Do not stop the controller with `kill -9`. Let `systemctl stop` finish.
- Watch the free space on the volume that holds the state directory and the
  witness.
- Give the host enough memory that the out-of-memory killer does not pick the
  controller.
- Before deciding anything about a failed start, run `auth fence inspect` to
  see whether it is this case.

Planned, not delivered: the next breaking release is meant to recognise at
start the state that follows a completed write, so that part of these stops no
longer needs a resume. The state before the write stays refused.

## Verification status and known limitations

Release-candidate evidence, Linux x64 only:

- **Installed acceptance.** `scripts/package-rbac.mjs` installs the Community
  tarball and the provider artifact into separate prefixes and drives only
  installed executables. The `public-0.1.1` baseline upgrades the registry
  `worktree-control@0.1.1` (schema 28) to schema 49 through fence
  establishment, then checks token and open modes without a provider, provider
  enrollment of the existing owner, account sign-in, the transport denial
  matrix, scoped MCP, revocation, TOTP replay rejection with a durable guessing
  budget, raw database rollback, protected resume and recovery. It also restores
  a backup created by the public `0.1.1` CLI into existing and empty directories:
  snapshot data is retained, later writes are absent, old credentials are
  refused, and explicitly reissued credentials and grants work. The `fresh`
  baseline runs the same account flow on a new installation. Both passed on the
  candidate. See [release packaging](release-packaging.md).
  On the integration branch the same harness follows the reset: the
  `public-0.1.1` baseline is refused at an ordinary start as needing
  establishment, `auth fence establish --backup-dir` brings it to schema 52 with
  the marker pending, ordinary openings are refused with `upgrade_required`,
  `upgrade inspect` and `upgrade apply` complete it, every pre-upgrade owner and
  agent credential is rejected, a new credential without a new grant is denied,
  and the existing acceptance continues with an explicitly recovered owner and
  new, explicitly granted credentials. Every resume (raw rollback and both
  restore destinations) is followed by inspect and apply before credentials.
  The `fresh` lane checks schema 52 with a complete marker and no upgrade.
- **Production composition and browser.** The production-composition suite
  passed on the candidate. The account browser tests (fixture UI and a real
  controller and provider behind the HTTPS proxy fixture) passed during the
  account-mode acceptance that preceded it.
- **Full provider proof: not green.** The provider's full proof suite reports
  five known failures out of 1,112 cases (1,107 pass), all in
  `factor-compatibility`. They characterize native and older bounded factor
  behaviour that the integrated production route replaces, and they are kept
  unmodified and unskipped. The full run on `370bac2` on 2026-11-08 reproduced
  exactly those five failures, with zero skipped tests and no additional
  failures. They cover TOTP reuse in the native and older bounded fixtures and
  a failed-guess counter lost by the bounded fixture after SQL rollback.
  These fixtures are not shipped. The integrated route uses a durable,
  monotonically increasing accepted TOTP step and commits each guessing charge
  before native verification. Its production-composition tests passed on the
  same commit. This classification does not make the full proof suite green.

- **Unclean stop during a protected write.** A stop the controller cannot
  catch, or a storage failure, between the pending and the confirmed witness can
  leave a refused start that only `auth fence resume` clears, and resume removes
  all credentials and grants. No behaviour change is planned for this release.
  See
  [After an unclean stop or a storage failure](#after-an-unclean-stop-or-a-storage-failure).

Not claimed: ASVS or other compliance, MFA hardware coverage, macOS or Windows
operation, protection against a trusted OS user or a whole-host rollback,
off-host anchoring of the security fence, and an OS sandbox for project code.
Agents running as the controller's OS user share the operator's authority over
the private socket and the protected CLI.

## Reference and history

The [authentication reference](https://github.com/pioootrek/worktree-control/blob/v0.2.0/docs/authentication-reference.md)
keeps the implementation slices (A3 proof, P1–P3, closed browser and factor
APIs), the dashboard sign-out protocol, the witness commit protocol and the
restore handoff details. Those sections describe internal contracts and their
original boundaries; this guide is the current operator contract.
