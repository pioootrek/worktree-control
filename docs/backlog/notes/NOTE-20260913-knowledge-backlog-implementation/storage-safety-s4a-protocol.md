# S4a: maintenance, handoff and restart contract

Written before implementation, 2026-10-01. Scope is service backups and the
installation operator. S4u, off-host transfer and operational acceptance stay
outside this slice. Startup arguments remain the service policy.

Only a currently authenticated installation token can browse or invoke web
backup operations. Open mode, legacy pairing and project/organization authority
are insufficient. Recheck the current token and CLI action policy at execution.
Local administration uses the existing private Unix socket or singleton lock.

Admission validates the catalog ID, backup and explicit whole-installation
confirmation using S3b, then persists a request outside SQLite before replying.
The client retains the same idempotency key across disconnects. A duplicate
returns its original operation; it never initiates another replacement.

Maintenance closes write/job admission across HTTP, MCP and local admin,
closes lifecycle and process-start admission before closing listeners, and
drains accepted operations while stopping owned processes. A pending start
checks the closed admission after its port preflight and during readiness;
queued starts cannot spawn after shutdown. It drains the single
backup executor, cancels finite tests through their existing state machine and
stops only process trees verified by the existing process manager. Failure of
any drain or cleanup stops the handoff. SQLite closes before the S3b executor
acquires database ownership. The controller singleton lock stays held.
HTTP, MCP and admin listeners share response draining: close admission to new
connections and close idle keep-alive connections after each accepted response
finishes. Status polling cannot keep the listener open; in-flight handlers
finish before persistence closes. Listener close calls coalesce.

Before closing SQLite, persist the current installation authentication policy
in a private checksummed handoff record outside the replaced database. It is
server-only material. After successful cleanup and database closure, persist
`executing`, then run the S3b executor. Rebuild the controller in the same Node
process with the same CLI arguments. Startup resumes an `executing` handoff
under exclusive ownership before ordinary database opening. Existing S3b
recovery remains responsible for interrupted file replacement.

Before reopening network admission, restore the captured authentication policy
and revoke all restored scoped credentials. Restored grants cannot authenticate
without newly issued credentials. Persist completion only after these writes.
A crash before that completion repeats invalidation safely. The installation
token current at handoff remains valid; historical installation tokens do not.
Status and receipts stay outside SQLite and require current authorization.

Live preview and restore admission validate in one bounded child without a
queue. The child opens only a disposable clone, never the controller database.
The CLI byte budget and timeout bound validation. The controller remains
responsive and checks current authorization and the manifest again after the
await. Equal pending restore keys coalesce; competing validation is refused.
Current admission is checked before and after validation, including an older
S3b receipt without an active handoff. Closing cannot admit a new handoff;
reauthorized status reads and repeats of already accepted handoffs remain reads.
Closing the controller terminates its exact verifier child, waits for exit and
removes its scratch clone before closing SQLite. Retention protects a source
under validation and rechecks restore receipts, source identity and manifest
after asynchronous verification. A durable admission starts the same handoff
even if the HTTP close event happened during validation.

| Crash boundary | Restart behavior |
| --- | --- |
| Before durable admission | No accepted operation; retry uses the same key. |
| During preview/admission validation | No replacement or accepted handoff. Normal shutdown terminates and drains its verifier; a controller crash can leave a disposable `.verify-*` clone for operator inspection. No attachment GC or broad scratch deletion. |
| Accepted, before maintenance/cleanup completes | Mark orchestration interrupted. Keep live data; explicit retry may continue the same S3b request after current authorization. |
| Cleanup fails or process stopping cannot be verified | No executor and no replacement. Preserve failure evidence; do not claim successful restore. |
| SQLite closed, before durable `executing` | No replacement occurred; record interruption. |
| Durable `executing`, before/within executor | Resume S3b request under database ownership before normal open; honor current CLI policy, preserve material on any conflict. |
| S3b verified, before security fence/completion | Repair receipt without another replacement; repeat authentication fence and credential invalidation before exposing listeners. |
| Completed, before listeners start | Open recovered data normally with original startup policy; retry reads the durable receipt. |

Backup requests and scheduler state use bounded private durable records outside
SQLite. Restart accounts for queued/running attempts as interrupted, recognizes
already published verified output, and retains their keys. One backup runs at a
time. Each restart schedules at most one overdue attempt, then advances to a
future deadline; manual creation leaves the deadline unchanged.

Retention runs only after a successful scheduled backup while that schedule is
enabled. It considers only this installation's recorded, verified scheduled
artifacts, protects the newest recovery point and restore sources, and leaves
pre-migration/manual/unknown artifacts and attachment storage alone. A budget
or retention failure is visible and does not stop the application.
