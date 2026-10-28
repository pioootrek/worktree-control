---
audience: "people running Worktree Control and choosing how callers authenticate"
last_reviewed: "2026-10-28"
source_of_truth: "authentication modes, owner CLI and scoped runtime agent workflow"
status: "active"
---

# Authentication modes

For planned human accounts, project roles, scoped agents and ENV permissions,
see the [identity and authorization plan](identity-authorization-plan.md).
A1 Knowledge roles and the A2 scoped runtime subset are implemented below;
account login, profile/configuration rights and ENV roles remain planned.

One authentication policy applies to the dashboard, the HTTP API, live updates,
MCP and the online CLI. The controller stores the policy in its database and
applies the active mode to every request.

| Mode | Who uses it | Access |
| --- | --- | --- |
| `token` | New installations | Installation-wide compatibility authority, including Knowledge; cannot sponsor scoped runtime agents |
| `open` | Explicit choice | Anonymous installation-wide compatibility authority; cannot sponsor scoped runtime agents |
| `legacy` | Installations created before modes existed | Browser pairing token, MCP `mcp-token`, owner sessions for knowledge |
| `better-auth` | Reserved | Not available yet; selecting it fails with `auth_provider_unavailable` |

Scoped agent tokens and owner sessions from `identity` commands keep working in
`legacy` and `token` modes. A controller whose stored mode is unavailable
refuses to start; it never falls back to another mode.

## Knowledge roles (A1)

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
Knowledge roles. This is not account-mode RBAC. Human account login and ENV roles remain later slices. Runtime credential
scopes and optional expiry are available through the A2 subset below. The
shared policy denies reserved ENV actions; the existing DEV vault continues to
require its separate signed proof and exact grants, with `use` unavailable.

Full backups retain bindings, revisions, tombstones and audit. As with existing
credentials, restoring an older snapshot can restore older authorization state;
external revocation fences are an A5 gate before account-mode activation.

## Scoped runtime agents (A2 subset)

A scoped agent can discover registered runtime projects, reserve one discovered
worktree, and control its claimed managed server. The only runtime actions are:

| Action | Operations |
| --- | --- |
| `projects:read` | Filtered `list_projects`, safe `get_project_status`, `list_worktrees` |
| `claims:manage` | Acquire, renew and release the session's own lease |
| `runtime:control` | Start, restart and stop under an active own lease; also required for `claim_project` with `start: true` |

The owner delegates actions to a stable agent for each registered runtime
project. Each credential has an exact project/action ceiling. Effective access
is their intersection, requiring an active agent, credential, delegation and
stored owner sponsor. Both credential and delegation expiry apply. A sponsor
is derived from the authenticated owner session; callers cannot supply one.
The owner's session may expire without ending durable sponsorship. Revoking the
owner principal blocks sponsored authority. Knowledge grants, DEV vault grants
and remote-verification grants remain independent.

### Owner workflow

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
contract accepts omission or null as no expiry; the CLI guard prevents an
accidental removal on update. Updates and revocations require the current revision.
Revocation retains a tombstone; restoration is a new set with its revision.
Stale mutations fail with a revision conflict (HTTP 409).

### Private MCP configuration and runtime use

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

Check `leaseHeld`, `error` and current safe status after an operation. Release
with `release_project_claim` when finished; release does not stop the server.

These scoped tools omit ENV, profile/configuration editing, local test admission,
logs, storage, capacity and foreign lease details. Runtime resources,
`get_project_status_compact` and `wait_for_status_change` are unavailable to
scoped agents. The HTTP runtime/dashboard API continues to reject their
credentials; runtime access is through these MCP tools. Unknown actions such
as `profiles:select`, `config:write`, test/log/ENV permissions cannot be granted.

### Rotate and revoke

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
including retained claim/runtime receipt retries. Automatic renewal rechecks
current authority and stops when denied. Existing leases retain their remaining
TTL; revocation does not release the lease or stop its server. Manual renew and
release also require current authority. A replacement session must wait for
expiry or ask a human to review the reservation. Already returned data cannot
be recalled.

### Upgrade and backup boundary

Schema migration 36 adds delegations, per-credential ceilings and optional
principal/credential lease bindings on the existing SQLite connection. Existing
principal IDs, credentials, Knowledge/vault/remote grants and unbound leases
remain intact. Existing agents receive no runtime backfill. Installation-token,
open and legacy compatibility callers retain their previous broad runtime
authority; scoped credentials do not isolate those callers.

Opening an older database with this version applies migration 36. Plan an
installation upgrade with a stopped-controller backup and a compatible restore
version; do not use a live database as a test fixture or open it with an older
binary after upgrade. Full backups preserve runtime grants, ceilings and lease
bindings. Restoring an older snapshot can restore older credential/delegation
state; A5 still owns external revocation fences and cutover acceptance.

The controller removes its token and keyfile environment variables from managed
process inheritance. Scoped authorization is not an OS sandbox: repository code
still executes with the controller's host identity and its permitted filesystem
access. This subset does not finish A2. Profile/configuration/test rights remain
deferred; A3 owns account GUI, A4 ENV policy and A5 compatibility cutover.

## The `auth` command

```bash
worktree-control auth status
worktree-control auth token generate
worktree-control auth token rotate
worktree-control auth mode set <open|token|better-auth>
```

When the controller is stopped, the command opens the database under the
controller's singleton lock. When it runs, the command talks to it through an
owner-only Unix socket, `admin.sock` in the state directory. The socket is
`0600` inside a `0700` directory. A policy change takes effect at once. The
controller closes MCP sessions and live dashboard connections, and those
callers must authenticate again.

`token generate` and `token rotate` print the token once. The first `start` or
`service install` of a new installation does the same; see
[Use token mode](#use-token-mode). The controller stores only a hash; a lost
token cannot be recovered, only rotated. Rotation
invalidates the previous token immediately. Save the token in a password
manager and keep it out of issues, logs and shared shell history.

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
```

### CLI in open mode

CLI commands need no token environment variable in `open` mode. The online
knowledge CLI and identity administration omit the `Authorization` header and
the controller applies the active mode. Offline identity administration, Hub
`knowledge execute-import` and logical `backup export-project` /
`import-project` read the persisted mode after acquiring the singleton lock.
Every such caller acts as the anonymous installation authority. New runtime
delegation/credential administration rejects that authority, even if an owner
token variable is set; use `token` or `legacy` mode with an owner session. Knowledge
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
3. Switch the mode: `worktree-control auth mode set token`. The pairing link
   and `mcp-token` stop working immediately.
4. Sign in to the dashboard with the token in each browser.
5. Replace the bearer token in every MCP client with the installation token.
   Agents that use scoped `wts_` tokens need no change.
6. Export `WORKTREE_CONTROL_TOKEN` where you run online CLI commands.

If a client still fails, run `auth status` to confirm the mode and the token
prefix. Rotate the token if it may have leaked.

## Upgrade notes and breaking changes

Upgrading an existing installation keeps it in `legacy` mode. The pairing link,
`mcp-token` and owner sessions keep working until you migrate. These changes
apply after the upgrade:

- **No downgrade.** The upgrade applies database migration 25. Controller
  backups record schema version 25, and older versions refuse to restore them.
- **No return to `legacy`.** After you select `token` or `open`, the pairing
  link and `mcp-token` stop working permanently.
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
