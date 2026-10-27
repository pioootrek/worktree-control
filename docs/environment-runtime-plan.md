---
audience: "owner, contributors, and coding agents"
last_reviewed: "2026-10-27"
source_of_truth: "Secret Runtime proposal integration direction for Worktree Control"
status: "active"
---

# Environment profiles and scoped runtime secrets

## Scope and provenance

Integrate the useful execution-facing part of the owner's Secret Runtime v2
proposal into Worktree Control: environment profiles, required-input checks, scoped
secret resolution, and delivery to approved processes. The first backend slice
now provides encrypted DEV profiles, bounded dotenv import, and owner-approved
agent read/write/use grant records. Read and write work through HTTP, MCP and
CLI. Execution use remains unavailable because local source observations do not
provide immutable execution isolation. There is no remote secret delivery or
vault GUI. See the [backend contract](dev-environment-vault.md) for implemented
operations, separate owner authentication, key provisioning and limits.
Existing literal profiles and separate test environments remain unchanged and
unencrypted; nothing automatically imports them into the vault.

The [source note](knowledge/AGENTS.md) (Knowledge attachment `2356069c892acf5e1160da52a3cab688`)
preserves the supplied archive and its six milestone proposals. Original stack
choices and priorities are historical proposals, not requirements for this
integration. Owner authorization on 2026-10-27 selected backend task
`731c4878-e19d-4acb-90e8-ea1340e94a78` as a concrete DEV-only slice of the existing
[environment profiles item](knowledge/AGENTS.md) (Knowledge task `92e7dab563aa6d7ee110ec007a65bfd6`)
and [remote verification plan](remote-verification-plan.md); split a bounded
implementation slice before coding. Existing urgent reliability repairs keep
priority. Remote unit checks without secrets need not wait for this module.

## First useful workflow

A caller requests a project, exact commit, configured test preset, selected
worker, and versioned environment profile. The worker authorizes the entire
combination, validates required inputs, resolves permitted secret references,
and injects values into the approved process. A missing or denied reference
fails before execution without falling back to another environment.

The caller receives readiness, missing-input categories, safe reference/version
metadata, and run evidence, not raw secret values. Persist the profile revision
and resolved secret version identifiers when available, never secret values or
plain hashes of secret values. Explicitly report unknown versions.

The initial demonstration uses dedicated test credentials on an owner-controlled
worker and a trusted fixture repository. It succeeds when a remote integration
test can run without copying plaintext env files between devices or placing
credentials in the LLM conversation. It does not promise to prevent the tested
application from writing secrets itself.

## Service and data boundary

Reuse Worktree Control's existing process owner, clean test environment assembly,
authorization services, and profile UI/API/MCP. A secret resolver is a separate
interface behind those services; do not build a second process controller or
replace SQLite merely because the source proposal chose PostgreSQL and Rust.
Any later privileged helper or hosted storage change needs a concrete reason.

Distinguish ordinary configuration, secret references, and access grants. Keep
secret values outside the general knowledge store, forum, exported context,
profile responses, and audit records. Access to a project discussion does not
authorize executing code with that project's credentials. Do not silently treat
existing literal profile values as encrypted vault data.

Start with one explicit worker-side source adapter selected for the actual
workflow: an approved local store or existing secrets service. Source adapter,
headless unlock/device identity, caching, grant lifetime, and recovery remain
design decisions. Do not make interactive human unlock a prerequisite for
every unattended test, or silently replace it with broad permanent credentials.
Hosted dispatch requests a permitted profile; worker policy controls resolution.

## Security properties and limits

Avoid creating persistent plaintext env files as the normal delivery mechanism.
Secret injection reduces unnecessary exposure but is not isolation from code
that receives the secret. An agent able to modify and execute repository scripts
can attempt to print or transmit injected values. Preset allowlisting alone
does not solve that problem. Tie grants to trusted source/revision policy,
environment, worker, principal, and least-privilege provider credentials.

Define whether dependency installation scripts, build steps, test steps, and
child processes receive a credential; do not grant the entire setup pipeline
the test profile by default. Production access requires its own policy rather
than inheritance from development or test configuration. Log filtering is not
a general guarantee against deliberate exfiltration.

Revoking a device or expiring a runtime grant blocks future authorized delivery;
it does not remove a copied secret from an existing process or revoke that
credential at its provider. Record these events separately. Likewise, audit
can prove that a version was supplied to a process, not every downstream use
of that value. Missing metadata must remain visible rather than inferred.

## Later lifecycle capabilities

After scoped delivery is useful, consider an environment contract that declares
required, optional, conditional, and forbidden variable names. Compare readiness
without returning values and distinguish absence from provider unavailability.
Reuse lessons from WinPath's audit as generic fixtures, not project-specific
branches in Worktree Control.

Version/expiry views, desired versus observed destination state, and explicit
pinning may follow. Different environments normally have separately authorized
values; synchronization is not blanket promotion of dev credentials to prod.
For write-only provider APIs, successful delivery is not proof of current value
equality. Show unknown/unverifiable observations honestly.

A hosted secret vault, Vercel/GitHub target adapters, and automated provider
rotation remain optional later designs. Choose whether a hosted service can
decrypt before promising client-only encryption or unattended server-side sync.
Rotation follows create, distribute, verify, then revoke with explicit recovery
for partial failure. Public hosting of secret material requires a separate
threat model, key-management/recovery design, and security verification.

## Verification and delivery

1. Specify one source adapter and profile/reference/grant contract. Preserve
   current literal and clean-test behavior while implementing a small resolver.
2. Prove local approved-process injection with fixture secrets, required-input
   rejection, and values absent from API/MCP, SQLite metadata, and audit output.
3. Combine it with exact-commit remote verification. Test wrong project/profile,
   untrusted source, expired/revoked grant, unavailable secret source, retries,
   and process failure without silently widening access.
4. Verify worker restart/unlock behavior, version attribution, artifact/log
   exposure, and cleanup. Document runtime visibility limits rather than making
   an absolute claim that the LLM can never obtain a secret.

The backend slice adds ciphertext-only SQLite persistence and a numbered schema
migration. It does not provision host keys, import real credentials, rotate
provider credentials, alter runtime/test environments, or register the historical
standalone project. GUI approval and source-isolated local use need separate
implementation and acceptance; remote delivery remains a later slice.
