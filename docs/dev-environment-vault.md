---
audience: "owner, backend contributors, and coding agents"
last_reviewed: "2026-10-27"
source_of_truth: "implemented DEV vault operations, dashboard owner workflow and security limits"
status: "active"
---

# DEV environment vault

The vault stores encrypted DEV environment profiles and supports explicit
owner approval of agent requests from the CLI or the dashboard **DEV vault**
section. It has no remote secret delivery. Execution use is unavailable. A saved use grant does not prove a test received
an environment, and no endpoint returns resolved values as a use operation.
Task `731c4878-e19d-4acb-90e8-ea1340e94a78` records owner authorization and
verification of the backend, and task `561ca263-c901-4f57-80f8-a0a15aaabb02`
the dashboard owner workflow. Parent `92e7dab563aa6d7ee110ec007a65bfd6`
remains the broader plan.

DEV credentials only. Never import staging or production credentials. The
command requires `environment: "DEV"`; values cannot reliably establish their
own classification. This classification does not set `NODE_ENV`. Build and
test tools retain their existing environment policy.

## Key and owner authentication boundary

The controller accepts two explicit external file paths at startup:

- `WORKTREE_CONTROL_DEV_VAULT_KEY_FILE` points to exactly 32 binary bytes for
  AES-256-GCM. The file must be regular, private (no group/other permissions),
  and outside Git checkouts and controller data and state directories.
- `WORKTREE_CONTROL_DEV_VAULT_OWNER_PUBLIC_KEY_FILE` points to an Ed25519 public
  PEM file outside those directories. It must not be group/other writable.

Keys are never generated, regenerated, imported from repositories or stored in
SQLite. Missing configuration leaves vault operations denied/unavailable while
ordinary controller functions remain available. The adapter rejects missing,
symlinked, oversized or incorrectly permissioned files and rejects master-key
replacement during a controller lifetime. Wrong keys and authentication-tag
failures produce the same safe unavailable error. No plaintext fallback exists.
Keep the master key in independently protected recovery storage. Losing it
makes encrypted profiles unreadable. Rotation and a recovery-key workflow are
not implemented.

Every owner operation requires both a current owner session and an external
Ed25519 signature. The private signing key stays with the owner; the controller
needs only its public key. The signature binds the full canonical command,
principal ID, credential ID, issued-at timestamp and domain string
`worktree-control-dev-vault-owner-v1`. JSON object keys are recursively sorted;
arrays retain order. The proof expires after 60 seconds and cannot be dated in
the future. The browser-safe `devOwnerSigningText` in
`src/shared/contracts/dev-vault-signing.ts` defines the exact text; the
controller's and CLI's `devOwnerSigningMessage` is its UTF-8 encoding. Tests
check that the browser signer produces byte-identical signatures.

Existing owner sessions alone are insufficient: legacy installation access can
bootstrap those sessions. Neither an installation bearer, open mode, CLI, TTY,
GUI route nor a supplied role grants vault owner authority. The generic identity
administration API cannot set the external verifier key. Agent grants bind the
requesting principal **and exact agent credential**, so an installation token
minting another token for that principal cannot inherit the grant. Token rotation
requires new approvals. Existing installation authority can still revoke
credentials or disrupt the controller; this feature does not prevent denial of
service or protect against same-account/root/full-controller compromise.

Owner key provisioning and custody require operator action outside this slice.
No real key material or credential imports were used in its development.

## Persistence and existing profiles

The dedicated `dev_environment_vaults` table stores only runtime project ID,
monotonic state version and authenticated ciphertext. The entire bounded state
is encrypted before persistence, including variable names and values, write
proposals, grants, audit records and idempotency requests/results. Profile
payloads have a further authenticated envelope bound to project/profile/revision.
Every seal uses a fresh random 96-bit GCM nonce. State envelopes bind the project,
state discriminator and state version. There are no unkeyed value hashes.

The adapter shares the controller's singleton SQLite connection. Compare-and-swap
commit atomically persists grant consumption, the encrypted response receipt and
updated profiles. A failed commit returns no value and consumes nothing. This
does not provide anti-rollback protection against a database/key holder restoring
an arbitrary old snapshot outside the supported restore workflow.

Profile identifiers are server-generated UUIDs. There are no caller-supplied
profile names or imported filenames to leak through metadata. Ordinary lists
return explicit metadata, never a serialized stored profile. Write responses
contain the resulting profile ID/revision/timestamps, without old values or
variable names. Owner inspection of a write request intentionally returns its
proposal after signature verification; explicit authorized reads return values.
Errors return fixed codes, without parser, file-provider or SQLite details.
HTTP and MCP responses disable caching. CLI failures omit request values.

Legacy `projects.environment_profiles_json` and
`projects.test_environment_profiles_json` remain plaintext literal settings.
Their shapes, runtime behavior and exports do not include encrypted profiles.
There is no automatic migration or selection of vault profiles through those
APIs. Runtime-project deletion is restricted while its vault row exists, so
generic deletion cannot silently discard encrypted data. An existing vault is
checked before the managed server is stopped, and the database constraint remains
the final deletion guard. A dedicated owner
deletion/reclamation workflow remains follow-up work.

## Operations and grants

`POST /api/dev-vault` and MCP tool `dev_vault` call the same application service.
The request shape is `{ "command": { ... }, "proof": { ... } }`. Agent commands
omit `proof`. Every command includes `projectId`, a UUID `operationId`,
`environment: "DEV"`, and `operation`. Project IDs refer to registered runtime
projects, not Knowledge projects. Requesting agents need the profile ID and
revision supplied by the owner; they cannot enumerate unapproved profiles.

| Operation | Additional fields | Authority and result |
| --- | --- | --- |
| `import` | `dotenv` | Signed owner; creates a profile at revision 1, returns metadata |
| `update` | `profileId`, `revision`, `dotenv` | Signed owner; applies a variable patch and advances the exact revision |
| `list` | None | Signed owner; profile metadata and `useAvailable: false` |
| `read` | `profileId`, `revision`, agent `grantId` | Signed owner or exact read grant; returns plaintext values |
| `request` | `profileId`, `revision`, `permission`; write `dotenv` and `source: "inline-dotenv"`; use `binding` | Current agent; creates an immutable pending request |
| `requests` | None | Signed owner sees all; agent sees only its exact credential's requests/grants, without write values/names |
| `inspect-request` | `requestId` | Signed owner; inspects the exact proposal before approving |
| `approve` | `requestId`, `revision`, `lifetime` | Signed owner; approves only a pending, current request for a current agent credential |
| `reject` | `requestId` | Signed owner; rejects a pending request |
| `revoke` | `grantId` | Signed owner; blocks future access, including plaintext retries |
| `write` | `grantId` | Exact write grant; applies only the immutable approved patch, returns metadata |
| `use` | `profileId`, `revision`, `grantId`, `binding` | Exact use grant/binding validation, then unavailable; never consumes or delivers values |
| `audit` | None | Signed owner; bounded operation/reference events, without values/names |

Read, write and use are independent. Write grants cannot administer permissions,
delete a profile or read old values. Grants pin an exact profile revision; no
wildcard revision grants exist. Write proposals update variables rather than
replace/delete profiles. The only write source is inline dotenv data. Approval
references an immutable request ID and its revision; callers cannot replace
its source or body. Once a successful write advances the profile, further writes
need a request for that new revision even if the original grant lifetime remains.

The owner selects `once`, `15-minutes` or `until-revoked`. Pending requests expire
after 15 minutes. Once grants expire after 24 hours if unused; the first operation
consumes the grant atomically. Identical retries with the same operation ID can
return the encrypted saved receipt while current authentication, grant expiry and
revocation still permit them. Another operation ID cannot reuse a consumed once
grant. Read retries also require the approved profile revision to remain current.
Write retries return only their saved metadata after advancing a revision.

Receipts retain at most 64 operations per project for 24 hours. Once consumption
survives receipt eviction, so a read whose receipt was evicted is denied rather
than consuming again. Idempotent import/request retries outside retention may
create a new record; do not use old operation IDs as permanent deduplication keys.
There are at most 16 profiles, 64 retained requests, 64 active grants, 8 pending
requests per credential and 128 audit events per project. Plain state is bounded
to 4 MiB before encryption; limit failures do not partially commit. Expired or
revoked records are removed on the next committed operation; access checks filter
them immediately, including after restart. Active indefinite grants retain their
request; reaching the active limit requires revocation before new approvals.

The parser accepts at most 32 KiB UTF-8, 100 distinct variables and 8192 bytes per
value. It accepts `NAME=value`, empty values, full comment lines, CRLF and simple
single/double quoted one-line values. It rejects duplicate keys, malformed names,
multiline values, shell `export`, escapes, interpolation, command substitution and
trailing comments. It never evaluates input. Runtime-controlled `PORT`, `NODE_ENV`,
`PATH`, loader variables, controller configuration variables and shell startup
variables are reserved. Conventional `APP_ENV`, `ENVIRONMENT`, `DEPLOYMENT_ENV`
and `STAGE` classifications explicitly set to staging/production are rejected.
It reports a category, never the offending name/value.

## CLI

`worktree-control vault --endpoint http://127.0.0.1:3410` reads a bounded JSON
request from stdin and calls the online HTTP operation. It never opens the DB or
infers owner status locally. Use `WORKTREE_CONTROL_DEV_VAULT_TOKEN` for the current
owner session or exact agent token. Installation-token variables are not fallbacks.
The endpoint must be HTTPS or loopback HTTP; redirects and credential-bearing
URLs are rejected.

For owner signing, set
`WORKTREE_CONTROL_DEV_VAULT_OWNER_PRIVATE_KEY_FILE` to a private Ed25519 PEM file.
The CLI verifies the session identity through `/api/identity`, signs the exact
command, then sends the proof. It does not generate keys. Alternatively supply
an already signed proof in stdin JSON. The CLI prints the DEV disclaimer to
stderr and the authorized operation response to stdout. Explicit reads expose
values to the caller, so protect redirected output and shell history. MCP tool
arguments and client transcripts may retain submitted values; do not submit real
credentials through an LLM conversation.

## Dashboard owner workflow

The **DEV vault** section manages the selected runtime project. It shows the
DEV-only disclaimer, the agent request contract and the controller's notice.
Owner proof follows the same contract as the CLI; there is no signing endpoint.

1. The owner pastes a `wts_` owner session token and chooses an unencrypted
   PKCS#8 Ed25519 private key PEM file. Encrypted keys are refused; use the
   CLI for those. The dashboard checks `/api/identity` and accepts only an
   `owner` principal with an `owner_session` credential. Installation and
   agent tokens are refused before any signing.
2. The browser imports the key with Web Crypto as a non-extractable signing key
   and overwrites the decoded DER. The PEM text, key and session token stay in
   that tab's memory only: never in local/session storage, IndexedDB, caches
   or a request. The controller receives only the owner session bearer and a
   signature over each exact command.
3. Signing locks on **Lock owner signing**, after 10 minutes without a vault
   operation, when the section unmounts, on reload or on dashboard sign-out.
   JavaScript strings, including the PEM text, cannot be reliably erased.

Web Crypto requires a secure context, so signing works only over HTTPS or a
loopback address and in browsers with Ed25519 support. Elsewhere the section
says signing is unavailable and offers no fallback. The proof timestamp is
dated one second in the past. It is corrected from the controller's `Date`
header only for an offset above three seconds.

Every list, reveal, import, inspection and decision is a separately signed
command. Profile and request lists contain metadata only. Values appear only
after an explicit **Reveal values** confirmation for that revision. They are
dropped on hide, lock, project change, a newer revision or leaving the section.
A write proposal appears only after a signed inspection, which must precede
signing its approval.

Approval shows the exact operation, agent principal and credential, the
credential's owner-assigned label when the read-only identity listing provides
it, the requested and current revision, expiry and any use binding. It states
the effect of the chosen lifetime. A write applies its immutable patch at most
once to that revision and is not general edit access; read and use stop at a
newer revision. A use approval is labelled as a saved grant, not delivery.
Expired, stale, missing-profile and revoked-credential requests cannot be
approved, and the controller re-checks these conditions when the signed
approval arrives. Rejection, revocation and the bounded audit log are also
available. Profile update and deletion are not.

Errors show fixed text for the response code only, never server text, names
or values. A transport failure keeps the operation ID, so retrying the same
action replays a committed receipt instead of repeating it. While signing is
unlocked, script running in the dashboard origin could use the loaded key to
sign commands without extracting it. Unlock only on a trusted device and lock
signing when finished.

## Backup, restore and remaining execution work

Full controller backup/restore retains the ciphertext table through the existing
SQLite backup and schema-validation path. Manifests contain no key or profile
payload. The master key and owner's signing key are never bundled. Restore needs
the separately recovered master key; an older controller rejects the newer schema
rather than dropping the table. Logical Knowledge/project context exports do not
include runtime vault profiles and are not a vault backup.

The production bootstrap checks the durable controller restore boundary on every
vault operation. Grants, pending requests and receipts created before an admitted
restore are denied even if restored ciphertext contains them. The owner can read
the profiles with their external key, a signature newer than the restore boundary,
and fresh approvals. Admitted failed
restores conservatively fence old authority too. Restoring snapshots manually
outside this path has no such anti-rollback guarantee.

A use request binds exact Git commit, preset ID, command digest, worker ID and
profile revision. Validation rejects substitutions, but execution still returns
`vault_use_unavailable`. The current finite queue observes mutable source at
endpoints; it cannot prove that the executable source stayed immutable between
observations. Implementing source isolation and queue admission is separate work.
No setup script, local finite job, development server or remote worker receives
vault values through this slice. Future delivery must authorize every profile
through its use grant, independently of read/write grants, and leave setup scripts
secret-free unless explicitly approved.

Code that eventually receives credentials can print or transmit them. Expiry and
revocation block future access; they cannot erase copies or revoke provider
credentials. JavaScript strings cannot be promised reliable zeroization.
Provider rotation, remote delivery, deletion/reclamation, encrypted-key browser
signing, hardware-backed owner keys and operational key management remain
unfinished.

Migration 33 is local to this branch's base. The parallel Knowledge
task-current-state branch also uses 33; integration must renumber/rebase one
migration and rerun migration, backup/restore, check and build verification.
On 2026-10-27, remote `main` at `b5da139` still supports schema 32, and
Knowledge PR #113 is open against `docs/knowledge-current-state-design` with
its own migration 33. Integration needs an approved base containing whichever
migration lands first before the other can become 34. Do not skip 33 or copy
the unmerged migration to manufacture that base. Do not apply either branch
to the other branch's live database as a workaround.
