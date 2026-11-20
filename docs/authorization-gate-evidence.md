---
audience: "authorization unification implementers and reviewers"
last_reviewed: "2026-11-20"
source_of_truth: "D1a-10 executable gate inventory; accepted plan in Knowledge task 040062b4"
status: "active"
---

# D1a gate evidence

This inventory splits the accepted Gate into separately checkable clauses. Review
by another model family is a process obligation, outside this implementation.
Statuses describe source evidence, not successful execution. Managed run results
must accompany the commit. Synthetic fixtures only; no approval of live exposure.

The guard `src/server/modules/operations/gate-audit.test.ts` parses this Markdown
table directly. It accepts registration at module level or in active
`describe`/`suite` callbacks (including `each`), literal-true branches and
nonempty literal-array `for...of` loops there. It rejects skipped, todo,
expected-failure proof, empty literal tables, dynamic/false branches, uncalled
functions, arbitrary nested callbacks, conditional expressions, short-circuit calls,
registration after an unconditional return/throw, index-based loops and try/catch registration.
Script steps additionally follow direct calls to named module-level helpers and
step callbacks; only the outer reporting try whose catch unconditionally sets
`process.exitCode = 1` is allowed. Other try paths are rejected. Presets resolve
through package-manager script chains, Vitest include patterns and CLI filters;
script rows require `node <supported flags> <file>`, never a filename in echo or
another program's arguments. Accepted totals, per-status counts and all 21
surface/mode keys are anchored in the guard independently of this document.
Defect rows still require reachable `it.fails`/`test.fails` evidence and a matching
preset. Defect, partial, deferral and not-applicable rows are not executable proof.
The guard cannot establish assertion meaning, runtime success, table contents
when nonliteral, import side effects, helper termination or runtime skip behavior.
It conservatively rejects registration forms outside the static rules above.

Provider methods below use real AccountProtection/SessionIssuance with fixture
native rows; the real Better Auth bootstrap/login and lifetime tests run under
`node:test:auth-provider-cli`. Provider configuration withdrawal fences human
sessions; agent/operator authority remains eligible by the accepted contract.
A changed HTTP grant can yield a newly recomputed DTO while connected; MCP
instead refuses a changed buffered witness. Neither writes a stale DTO.

Gate rows: 191. Artifact cells: 21.

## Gate clauses

| Gate item | File | Test title | Preset | Status |
| --- | --- | --- | --- | --- |
| Unit: owner-token promotion | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `refuses credential kind %s and principal kind %s despite a correct secret` | `node:check` | proven before this step |
| Unit: worker-token promotion | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `refuses credential kind %s and principal kind %s despite a correct secret` | `node:check` | proven before this step |
| Unit: mismatched principal kind | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `refuses credential kind %s and principal kind %s despite a correct secret` | `node:check` | proven before this step |
| Unit: forged agent ID | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `refuses forged IDs and wrong secrets for real IDs` | `node:check` | proven before this step |
| Unit: revoked credential | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `refuses %s at mint` | `node:check` | proven before this step |
| Unit: invalid cookie with valid bearer | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `a mixed invalid cookie and valid bearer refuses before the agent reader` | `node:check` | proven before this step |
| Unit: same-ID secret replacement (defensive) | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `same-ID secret replacement returns a changed identity; the boundary, not current, rejects it` | `node:check` | proven before this step |
| Unit: disable | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `disabling and re-enabling the %s with identical facts restores this request` | `node:check` | proven before this step |
| Unit: re-enable | `src/server/modules/operations/adapters/agent-token-verifier.test.ts` | `disabling and re-enabling the %s with identical facts restores this request` | `node:check` | proven before this step |
| Composition: grant removed after successful read | `src/server/modules/operations/operations-runtime-composition.test.ts` | `reads new grants after an earlier read and between mint and execution` | `node:check` | proven before this step |
| Composition: grant removed between mint and execution | `src/server/modules/operations/operations-runtime-composition.test.ts` | `reads new grants after an earlier read and between mint and execution` | `node:check` | proven before this step |
| Composition: provider configuration between resolve and mint | `src/server/modules/operations/operations-runtime-composition.test.ts` | `fences human sessions after %s between resolve and mint and between mint and execution` | `node:check` | proven before this step |
| Composition: provider configuration between mint and execution | `src/server/modules/operations/operations-runtime-composition.test.ts` | `fences human sessions after %s between resolve and mint and between mint and execution` | `node:check` | proven before this step |
| Composition: maintenance between resolve and mint | `src/server/modules/operations/operations-runtime-composition.test.ts` | `fences human sessions after %s between resolve and mint and between mint and execution` | `node:check` | proven before this step |
| Composition: maintenance between mint and execution | `src/server/modules/operations/operations-runtime-composition.test.ts` | `fences human sessions after %s between resolve and mint and between mint and execution` | `node:check` | proven before this step |
| Composition: no successful human DTO after eligibility loss | `src/server/modules/operations/operations-runtime-composition.test.ts` | `fences human sessions after %s between resolve and mint and between mint and execution` | `node:check` | proven before this step |
| Composition: zero roles | `src/server/modules/operations/operations-runtime-composition.test.ts` | `describes an agent with %s roles` | `node:check` | proven before this step |
| Composition: executor-only visibility | `src/server/modules/operations/operations-runtime-composition.test.ts` | `describes an agent with %s roles` | `node:check` | proven before this step |
| Composition: admin without secrets | `src/server/modules/operations/operations-runtime-composition.test.ts` | `describes a human with %s only using the provider-session fixture` | `node:check` | proven before this step |
| Composition: secrets-only visibility | `src/server/modules/operations/operations-runtime-composition.test.ts` | `describes a human with %s only using the provider-session fixture` | `node:check` | proven before this step |
| Composition: archived projects | `src/server/modules/operations/operations-runtime-composition.test.ts` | `describes the %s installation and each served listener` | `node:check` | proven before this step |
| Composition: invalid IDs | `src/server/modules/operations/operations-runtime-composition.test.ts` | `bounds the listing, omits invalid IDs and includes archived projects` | `node:check` | added in this step |
| Composition: listing bounds | `src/server/modules/operations/operations-runtime-composition.test.ts` | `bounds the listing, omits invalid IDs and includes archived projects` | `node:check` | added in this step |
| Composition: revoked credential after mint | `src/server/modules/operations/operations-runtime-composition.test.ts` | `refuses a changed %s after mint` | `node:check` | proven before this step |
| Composition: revoked account after mint | `src/server/modules/operations/operations-runtime-composition.test.ts` | `refuses a changed %s after mint` | `node:check` | proven before this step |
| Composition: changed fingerprint after mint | `src/server/modules/operations/operations-runtime-composition.test.ts` | `refuses a changed %s after mint` | `node:check` | proven before this step |
| Listeners API/unix: allowed matrix | `src/server/modules/operations/http-boundary-conformance.test.ts` | `full wire matrix in %s, with no old authentication or usage write` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: denied matrix and exact public reasons | `src/server/modules/operations/http-boundary-conformance.test.ts` | `full wire matrix in %s, with no old authentication or usage write` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: legacy startup and unknown_mode (source start: installed CLI cannot select legacy) | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real legacy startup refuses all mounted operations and CLI with a consistent fence` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: unchanged legacy authentication | `src/server/modules/operations/http-boundary-conformance.test.ts` | `full wire matrix in %s, with no old authentication or usage write` | `node:test:operations-mcp` | proven before this step |
| Listeners worker: allowed matrix | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored credential matrix in %s; protocol retains worker authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners worker: denied matrix and exact public reasons | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored credential matrix in %s; protocol retains worker authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners worker: legacy startup and unknown_mode (source start: installed CLI cannot select legacy) | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real legacy startup refuses all mounted operations and CLI with a consistent fence` | `node:test:operations-mcp` | added in this step |
| Listeners worker: unchanged legacy authentication | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored credential matrix in %s; protocol retains worker authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: allowed matrix | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored matrix in %s on every method; unchanged legacy authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: denied matrix and exact public reasons | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored matrix in %s on every method; unchanged legacy authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: legacy startup and unknown_mode (source start: installed CLI cannot select legacy) | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real legacy startup refuses all mounted operations and CLI with a consistent fence` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: unchanged legacy authentication | `src/server/modules/operations/http-boundary-conformance.test.ts` | `stored matrix in %s on every method; unchanged legacy authentication` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: duplicate credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `preserves duplicate and mixed raw credentials` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: mixed credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `preserves duplicate and mixed raw credentials` | `node:test:operations-mcp` | proven before this step |
| Listeners worker: duplicate credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `preserves mixed and duplicate credentials and refuses cookies before any work in %s` | `node:test:operations-mcp` | proven before this step |
| Listeners worker: mixed credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `preserves mixed and duplicate credentials and refuses cookies before any work in %s` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: duplicate credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s mixed and duplicate raw credentials, cookie preflight and no provider/budget work` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: mixed credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s mixed and duplicate raw credentials, cookie preflight and no provider/budget work` | `node:test:operations-mcp` | proven before this step |
| Listeners API: spoofed actor | `src/server/modules/operations/http-boundary-conformance.test.ts` | `agent sees zero roles, then only its one project; body and headers grant no authority` | `node:test:operations-mcp` | proven before this step |
| Listeners API: spoofed session | `src/server/modules/operations/http-boundary-conformance.test.ts` | `agent sees zero roles, then only its one project; body and headers grant no authority` | `node:test:operations-mcp` | proven before this step |
| Listeners cookie: spoofed actor | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie strict JSON and server-owned authority: %s` | `node:test:operations-mcp` | proven before this step |
| Listeners cookie: spoofed session | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie strict JSON and server-owned authority: %s` | `node:test:operations-mcp` | proven before this step |
| Listeners cookie: strict JSON | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie strict JSON and server-owned authority: %s` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: strict JSON | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: path traversal | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: encoding | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: trailing slash | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: query variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners API/unix: method variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `strict JSON, content type, path and all method refusals remain terminal on both listeners` | `node:test:operations-mcp` | added in this step |
| Listeners worker: spoofed actor | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: spoofed session | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: strict JSON | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: path traversal | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: encoding | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: trailing slash | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: query variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners worker: method variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: strict JSON | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted MCP rejects strict JSON and spoofed authority fields without changing identity` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: path traversal | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: encoding | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: trailing slash | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: query variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: method variants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners MCP: legacy routes unreached | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, reserved HTTP namespace, methods and batches are terminal` | `node:test:operations-mcp` | proven before this step |
| Listeners API/unix: legacy routes unreached | `src/server/modules/operations/http-boundary-conformance.test.ts` | `refuses normalized aliases before all legacy work, with cookie refusal first` | `node:test:operations-mcp` | proven before this step |
| Boundary: Host | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: cookie size | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: cookie alias | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: duplicate managed cookie | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: Origin | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: Fetch Metadata | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects %s before body, budget and provider` | `node:test:operations-mcp` | proven before this step |
| Boundary: singleton headers | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie boundary rejects duplicate %s` | `node:test:operations-mcp` | proven before this step |
| Boundary: worker peer | `src/server/modules/operations/http-boundary-conformance.test.ts` | `shares peer and Origin refusals with poll/report and keeps Fetch Metadata policy` | `node:test:operations-mcp` | proven before this step |
| Boundary: worker Origin | `src/server/modules/operations/http-boundary-conformance.test.ts` | `shares peer and Origin refusals with poll/report and keeps Fetch Metadata policy` | `node:test:operations-mcp` | proven before this step |
| Boundary: browser headers on unix | `src/server/modules/operations/http-boundary-conformance.test.ts` | `refuses browser headers and every credential on unix` | `node:test:operations-mcp` | proven before this step |
| Limits API/unix: body | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s enforces production byte ceilings before mint (unix legacy executor stubbed)` | `node:test:operations-mcp` | proven before this step |
| Limits worker: body | `src/server/modules/operations/http-boundary-conformance.test.ts` | `raw aliases, methods, JSON and byte limits terminate before poll/report` | `node:test:operations-mcp` | proven before this step |
| Limits MCP: body | `src/server/modules/operations/http-boundary-conformance.test.ts` | `MCP body/DTO ceilings and Node completion retain the production owner` | `node:test:operations-mcp` | proven before this step |
| Admission API/unix: contention | `src/server/modules/operations/http-boundary-conformance.test.ts` | `matches legacy Retry-After during real provider-storage contention on both operations listeners` | `node:test:operations-mcp` | proven before this step |
| Admission worker: contention | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real admission contention keeps its retryable public reason` | `node:test:operations-mcp` | proven before this step |
| Admission MCP: contention | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real admission contention and aborted admission preserve exact reasons` | `node:test:operations-mcp` | proven before this step |
| Legacy API/unix: unchanged routes | `src/server/modules/operations/http-boundary-conformance.test.ts` | `keeps legacy paths working in legacy mode, five per listener (unix executor stubbed)` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: pause after runner before real write | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: configuration | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: grants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: deadline | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: disconnect | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release HTTP: no stale DTO | `src/server/modules/operations/http-boundary-conformance.test.ts` | `cookie release recomputes after runner completion: %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: pause after runner before real write | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: credential | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: grant | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: deadline | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release worker: connection | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: pause after SDK before real write | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: credentials | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: grants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: deadline | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: connection | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: configuration preserves agent authority | `src/server/modules/operations/http-boundary-conformance.test.ts` | `post-SDK-buffer release rechecks %s` | `node:test:operations-mcp` | proven before this step |
| Release MCP: full witness for initialize/list/call/notification | `src/server/modules/operations/http-boundary-conformance.test.ts` | `MCP full witness gates post-buffer release for $method` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: omitted maintenance guard starts exactly one measured mint | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: omitted maintenance guard starts exactly one measured mint` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: early slot release admits request 33 while all 32 works remain unsettled | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: early slot release admits request 33 while all 32 works remain unsettled` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: buffered success without revalidation writes exactly 200 with a DTO after maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: buffered success without revalidation writes exactly 200 with a DTO after maintenance` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: omitted origin guard fails cookie origin boundary with 200 versus 403 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: omitted origin guard fails cookie origin boundary with 200 versus 403` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: removing only required-Origin fails cookie required Origin boundary with 200 versus 403 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: removing only required-Origin fails cookie required Origin boundary with 200 versus 403` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: early work settlement fails cookie capacity until settlement with 401 versus 503 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: early work settlement fails cookie capacity until settlement with 401 versus 503` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: premature buffered success fails cookie maintenance release with 200 versus 401 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: premature buffered success fails cookie maintenance release with 200 versus 401` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: omitted Origin guard has the exact conformance failure | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: omitted Origin guard has the exact conformance failure` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: early capacity release fails with 200 versus 503 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: early capacity release fails with 200 versus 503` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: premature success fails the shared maintenance release assertion | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: premature success fails the shared maintenance release assertion` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: omitted shared Origin guard fails exactly 404 versus 403 | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: omitted shared Origin guard fails exactly 404 versus 403` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: early release admits request 33 while work remains pending | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: early release admits request 33 while work remains pending` | `node:test:operations-mcp` | proven before this step |
| Conformance: negative control: premature SDK success fails exactly with stale result true versus false | `src/server/modules/operations/http-boundary-conformance.test.ts` | `negative control: premature SDK success fails exactly with stale result true versus false` | `node:test:operations-mcp` | proven before this step |
| Reserve: sign-out under initiating saturation | `packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` | `closes D1a-5a reserve deferral: sign-out and an accepted login completion succeed with operations initiating cap saturated` | `node:test:auth-provider-cli` | proven before this step |
| Reserve: accepted completion under initiating saturation | `packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` | `closes D1a-5a reserve deferral: sign-out and an accepted login completion succeed with operations initiating cap saturated` | `node:test:auth-provider-cli` | proven before this step |
| Historical 5a: cookie refused with no body | `src/server/modules/operations/http-boundary-conformance.test.ts` | `historical 5a refusal-only cookie ordering on %s performs no application work` | `node:test:operations-mcp` | added in this step |
| Historical 5a: cookie refused with no slot | `src/server/modules/operations/http-boundary-conformance.test.ts` | `historical 5a refusal-only cookie ordering on %s performs no application work` | `node:test:operations-mcp` | added in this step |
| Historical 5a: cookie refused with no admission | `src/server/modules/operations/http-boundary-conformance.test.ts` | `historical 5a refusal-only cookie ordering on %s performs no application work` | `node:test:operations-mcp` | added in this step |
| Historical 5a: cookie refused with no provider work | `src/server/modules/operations/http-boundary-conformance.test.ts` | `historical 5a refusal-only cookie ordering on %s performs no application work` | `node:test:operations-mcp` | added in this step |
| Offline pre-open: pending handoff | `src/cli/session-describe.test.ts` | `%s restore handoff stops before store construction` | `node:test:session-describe` | proven before this step |
| Offline pre-open: malformed handoff | `src/cli/session-describe.test.ts` | `%s restore handoff stops before store construction` | `node:test:session-describe` | proven before this step |
| Offline pre-open: unreadable handoff | `src/cli/session-describe.test.ts` | `%s restore handoff stops before store construction` | `node:test:session-describe` | proven before this step |
| Lifetime: mixed old/new shared budget saturation | `src/server/modules/operations/http-boundary-conformance.test.ts` | `shares the real unix ceiling and drain with a stubbed /auth executor after disconnect` | `node:test:operations-mcp` | proven before this step |
| Lifetime: mixed browser/operations budget | `packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` | `closes D1a-5a reserve deferral: sign-out and an accepted login completion succeed with operations initiating cap saturated` | `node:test:auth-provider-cli` | proven before this step |
| Lifetime: slow responses | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s completes a large real DTO under real socket backpressure` | `node:test:operations-mcp` | proven before this step |
| Lifetime: disconnects | `src/server/modules/operations/http-boundary-conformance.test.ts` | `retains all 32 API slots until disconnected work settles through production dispatch` | `node:test:operations-mcp` | proven before this step |
| Lifetime: queued cancellation | `src/server/modules/operations/http-boundary-conformance.test.ts` | `refuses admission contention while real provider storage is pending, and cancels a queued disconnected request` | `node:test:operations-mcp` | proven before this step |
| Lifetime: blocked real provider with repeated disconnected requests | `packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` | `production shutdown retains SQLite and controller lock during a blocked real provider delete and repeated cookie disconnects` | `node:test:auth-provider-cli` | proven before this step |
| Lifetime: shutdown only after started work settles | `packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts` | `production shutdown retains SQLite and controller lock during a blocked real provider delete and repeated cookie disconnects` | `node:test:auth-provider-cli` | proven before this step |
| MCP isolation: sequential initialize | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s SDK sequential initialize/list/call has no session authority` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: sequential list | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s SDK sequential initialize/list/call has no session authority` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: sequential call | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s SDK sequential initialize/list/call has no session authority` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: distinct principals with identical JSON-RPC IDs | `src/server/modules/operations/http-boundary-conformance.test.ts` | `concurrent distinct principals with identical IDs and forged session headers stay isolated` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: forged session headers | `src/server/modules/operations/http-boundary-conformance.test.ts` | `concurrent distinct principals with identical IDs and forged session headers stay isolated` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: aborted admission | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real admission contention and aborted admission preserve exact reasons` | `node:test:operations-mcp` | proven before this step |
| MCP isolation: repeated cleanup | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s close joins pending owners before SQLite/lock release; repeated cleanup` | `node:test:operations-mcp` | proven before this step |
| Offline: real lock record replaced under command | `src/cli/session-describe.test.ts` | `replaced real record %s refuses without stdout` | `node:test:session-describe` | proven before this step |
| Offline: next phase offline_lock_not_held | `src/cli/session-describe.test.ts` | `replaced real record %s refuses without stdout` | `node:test:session-describe` | proven before this step |
| Observation: bearer never calls old authenticator | `src/server/modules/operations/http-boundary-conformance.test.ts` | `full wire matrix in %s, with no old authentication or usage write` | `node:test:operations-mcp` | proven before this step |
| Observation: bearer never calls usage writer | `src/server/modules/operations/http-boundary-conformance.test.ts` | `full wire matrix in %s, with no old authentication or usage write` | `node:test:operations-mcp` | proven before this step |
| Fresh login: password | `src/server/modules/operations/adapters/provider-session-verifier.test.ts` | `password: authenticates a human and carries the evidence's authentication time` | `node:check` | proven before this step |
| Fresh login: password_totp | `src/server/modules/operations/adapters/provider-session-verifier.test.ts` | `password_totp: carries the password stage's time, not the session's creation` | `node:check` | proven before this step |
| Fresh login: passkey_uv | `src/server/modules/operations/adapters/provider-session-verifier.test.ts` | `passkey_uv: authenticates with the passkey login's time` | `node:check` | proven before this step |
| Fresh login: 600000 ms test operation | `src/server/modules/operations/adapters/provider-session-verifier.test.ts` | `allows 599999 ms and refuses 600000 ms` | `node:check` | proven before this step |
| DTO parity: common semantics and actor/listener differences | `src/cli/session-describe.test.ts` | `unix %s equals offline and API authority with exactly actor/listener differences` | `node:test:session-describe` | proven before this step |
| DTO parity: human freshness difference | `src/cli/session-describe.test.ts` | `better-auth human freshness differs exactly from the offline operator` | `node:test:session-describe` | proven before this step |
| Non-disclosure: credential IDs in responses | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted responses and diagnostic sinks never disclose stored session or credential row IDs` | `node:test:operations-mcp` | added in this step |
| Non-disclosure: credential IDs in diagnostics | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted responses and diagnostic sinks never disclose stored session or credential row IDs` | `node:test:operations-mcp` | added in this step |
| Non-disclosure: session row IDs in responses | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted responses and diagnostic sinks never disclose stored session or credential row IDs` | `node:test:operations-mcp` | added in this step |
| Production registry: exactly approved operation IDs | `src/server/modules/operations/operations-runtime-composition.test.ts` | `pins the production registry and logs disposal failures without thrown values or credential facts` | `node:check` | proven before this step |
| Earlier deferral worker: slow-header expiry | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s production timeouts remain documented; real slow headers and request expiry refuse before mint` | `node:test:operations-mcp` | added in this step |
| Earlier deferral worker: request-timeout expiry | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s production timeouts remain documented; real slow headers and request expiry refuse before mint` | `node:test:operations-mcp` | added in this step |
| Earlier deferral MCP: slow-header expiry | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s production timeouts remain documented; real slow headers and request expiry refuse before mint` | `node:test:operations-mcp` | added in this step |
| Earlier deferral MCP: request-timeout expiry | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s production timeouts remain documented; real slow headers and request expiry refuse before mint` | `node:test:operations-mcp` | added in this step |
| Timeout settings: production documented values | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s production timeouts remain documented; real slow headers and request expiry refuse before mint` | `node:test:operations-mcp` | added in this step |
| Earlier deferral: offline upgrade diagnostic | `src/cli/session-describe.test.ts` | `upgrade-required offline command preserves the diagnostic, never enables writes, and releases both locks` | `node:test:session-describe` | added in this step |
| Earlier deferral: offline upgrade never enables writes | `src/cli/session-describe.test.ts` | `upgrade-required offline command preserves the diagnostic, never enables writes, and releases both locks` | `node:test:session-describe` | added in this step |
| Earlier deferral: offline upgrade releases locks | `src/cli/session-describe.test.ts` | `upgrade-required offline command preserves the diagnostic, never enables writes, and releases both locks` | `node:test:session-describe` | added in this step |

| Non-disclosure: session row IDs in diagnostics | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted responses and diagnostic sinks never disclose stored session or credential row IDs` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: spoofed actor | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted MCP rejects strict JSON and spoofed authority fields without changing identity` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: spoofed session | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted MCP rejects strict JSON and spoofed authority fields without changing identity` | `node:test:operations-mcp` | added in this step |
| Listeners MCP: spoofed listener | `src/server/modules/operations/http-boundary-conformance.test.ts` | `mounted MCP rejects strict JSON and spoofed authority fields without changing identity` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: credential | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: grants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: deadline | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: connection | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion api: provider configuration | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | not applicable: provider-only changes do not fence agent or operator authority; the named test asserts a fresh successful DTO |
| Release after runner completion unix: maintenance | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion unix: credential | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | not applicable: operator has no credential; the named test exercises all applicable fences |
| Release after runner completion unix: grants | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion unix: deadline | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion unix: connection | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | added in this step |
| Release after runner completion unix: provider configuration | `src/server/modules/operations/http-boundary-conformance.test.ts` | `%s release after runner completion recomputes every applicable authority fence` | `node:test:operations-mcp` | not applicable: provider-only changes do not fence agent or operator authority; the named test asserts a fresh successful DTO |
| Release after runner completion worker: provider configuration | `src/server/modules/operations/http-boundary-conformance.test.ts` | `fresh release after runner completion rechecks %s` | `node:test:operations-mcp` | not applicable: provider-only configuration does not fence agent authority; the named configuration case retains a fresh successful DTO |
| API no cookie boundary: open/token/better-auth before body but with mint admission | `src/server/modules/operations/http-boundary-conformance.test.ts` | `API %s without a cookie boundary refuses before body and provider slots but uses mint admission` | `node:test:operations-mcp` | added in this step |
| Worker legacy header names: recognized token semantics | `src/server/modules/operations/http-boundary-conformance.test.ts` | `worker %s recognized tokens in legacy header names retain bearer semantics` | `node:test:operations-mcp` | added in this step |
| Legacy real startup: API/unix/worker/MCP/CLI socket and offline (source start: installed CLI cannot select legacy) | `src/server/modules/operations/http-boundary-conformance.test.ts` | `real legacy startup refuses all mounted operations and CLI with a consistent fence` | `node:test:operations-mcp` | added in this step |
| Listing: complete serialized DTO byte bound | `src/server/modules/operations/session-describe.test.ts` | `accounts for the complete DTO when the last project puts it %i bytes over budget` | `node:check` | added in this step |
| Listing: equal prefix across listener widths | `src/server/modules/operations/session-describe.test.ts` | `keeps the same prefix across API, MCP and worker at a listener-width boundary` | `node:check` | added in this step |
| Listing: MCP SDK serialized message and DTO byte bounds | `src/server/modules/operations/mcp-request-adapter.test.ts` | `measures 500 full-authority projects with %i-byte IDs against both default DTO bounds` | `node:test:operations-mcp` | added in this step |

## Installed artifact matrix

Each row is an installed controller/CLI assertion on synthetic state. Open mode
accepts no bearer; its bearer cell proves anonymous success and credential refusal.
Cookie cells in open/token mode are refusal-only by contract. CLI has no credential input: socket refusal is `admin_socket_missing`. Each
offline cell proves per-mode success; the upgrade diagnostic is one
mode-independent step, `upgrade-required-offline-session-describe`, in the
released-baseline lane. It is not a separate refusal in each mode.
The unix wire cell proves `credential_on_local_listener` in every mode.

`node:test:package:provider` builds the separate reproducible provider; it does
not execute listeners. The real provider is installed and exercised by the RBAC
artifact preset. The report's `operationsMatrix` records each cell, expected actor,
listener, refusal and timed step. The provider proof also runs separately.

| Gate item | File | Test title | Preset | Status |
| --- | --- | --- | --- | --- |
| Installed API bearer: open | `scripts/package-rbac.mjs` | `operations-api-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed API bearer: token | `scripts/package-rbac.mjs` | `operations-api-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed API bearer: better-auth | `scripts/package-rbac.mjs` | `operations-api-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed unix socket: open | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed unix socket: token | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed unix socket: better-auth | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed worker TLS: open | `scripts/package-rbac.mjs` | `operations-worker-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed worker TLS: token | `scripts/package-rbac.mjs` | `operations-worker-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed worker TLS: better-auth | `scripts/package-rbac.mjs` | `operations-worker-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed MCP initialize/list/call: open | `scripts/package-rbac.mjs` | `describe-rpc-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed MCP initialize/list/call: token | `scripts/package-rbac.mjs` | `describe-rpc-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed MCP initialize/list/call: better-auth | `scripts/package-rbac.mjs` | `describe-rpc-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI socket: open | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI socket: token | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI socket: better-auth | `scripts/package-rbac.mjs` | `operations-unix-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI offline: open | `scripts/package-rbac.mjs` | `operations-offline-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI offline: token | `scripts/package-rbac.mjs` | `operations-offline-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed CLI offline: better-auth | `scripts/package-rbac.mjs` | `operations-offline-${mode}` | `node:test:rbac-artifact` | added in this step |
| Installed API cookie: open | `scripts/package-rbac.mjs` | `community-open-mode-without-provider` | `node:test:rbac-artifact` | proven before this step |
| Installed API cookie: token | `scripts/package-rbac.mjs` | `community-token-mode-without-provider` | `node:test:rbac-artifact` | proven before this step |
| Installed API cookie: better-auth | `scripts/package-rbac.mjs` | `public-packaged-login-and-transport-denial-matrix` | `node:test:rbac-artifact` | proven before this step |

The Community smoke preset additionally runs `operations-installed-token-and-local`,
`operations-installed-mcp-token` and `operations-installed-offline-token` in
`scripts/package-smoke.mjs`. D1a-10 strengthens its API mode/listener assertions.
The public mode setter cannot select `legacy`. The `node:test:operations-mcp`
fixture saves that policy through the store's fenced API, closes the store and
starts the controller from its source entry point. It checks the full
`unknown_mode` response on all four listeners and both CLI paths, then reopens
the fixture database to verify that its witness still matches.

Added raw MCP requests
and refusal probes are timed in existing script reports; exact runtime growth
requires before/after measurements on the same host and is not inferred from
source. The focused listener expiry tests use a 25 ms real Node scan interval. Worker
expiry runs at the actual 10000 ms header and 15000 ms request values. Its body
case spends eight seconds in headers so Node expires the complete request before
the adapter's body deadline. MCP alone uses 200 ms headers and 400 ms request
fixture overrides for its minute-scale defaults; production values are asserted
before those overrides. No fake clock or production timeout change is used.

## Long timeout exceptions

All other composition, CLI and conformance cases use the default timeout.
The four former 30 s cases in `session-describe.test.ts` now use the default:
they build in-memory project lists without durable writes, subprocesses or real
timers. The nine former 20 s cases in `offline-ownership.test.ts` now use the
default too: each uses one small synthetic store and controlled promise barriers,
with no large row load, child process or elapsed-time wait.
The exceptions are:

- The four 30 s cases in `unmounted.test.ts` (`has exactly the approved importers and no unlisted non-literal specifier`,
  `allows only the separate MCP listener to mount the request adapter, including indirect production importers`,
  `allows only controller start and the unmounted offline composition to import the composition`,
  `allows exactly the session describe command to mount the offline composition`):
  parse the full repository import graph; retain headroom for this large source scan.
- `real legacy startup refuses all mounted operations and CLI with a consistent fence`:
  40 s, real CLI startup, TLS listener and multiple CLI subprocesses.

- `bounds the listing, omits invalid IDs and includes archived projects`: 20 s,
  inserts 500 durable rows.
- `%s completes a large real DTO under real socket backpressure`: 20 s,
  inserts 300 durable rows.
- `uses the socket's real ten second deadline for a slow operations body`:
  15 s, production timer.
- `deadline aborts resolution and admission but retains real unsettled work and response drain`:
  15 s, production timer.
- `deadline cancels work held after mint, retains ownership, and shutdown joins work before SQLite and lock release`:
  15 s, production timer.
- `MCP deadline retains capacity until real work settles; legacy requests retain independent admission`:
  30 s, production timer.
- `%s production timeouts remain documented; real slow headers and request expiry refuse before mint`:
  40 s, real Node header/request expiry.
- `mounted responses and diagnostic sinks never disclose stored session or credential row IDs`:
  30 s, real CLI subprocesses.
- `upgrade-required offline command preserves the diagnostic, never enables writes, and releases both locks`:
  40 s, real CLI subprocess.
- `lock taken: %s fails exactly, never opens a store or acquires ownership`:
  30 s, includes the real client timeout.
- `$path: large output with $reader reader releases ownership before pipe drain`:
  40 s, subprocesses, 500 rows and slow pipe readers.

The existing adapter byte-bound test `measures 500 full-authority projects with %i-byte IDs against both default DTO bounds`
keeps 30 s because it inserts 500 durable rows and exercises the SDK envelope.

## Earlier deferrals and scope

Search inventory: `D1a-10` and `deferral` in the authorization contract,
operation dispositions and authentication guide. The CLI neighbour row's
`D1a-10-upgrade-CLI` is closed by the offline upgrade test above and installed
`upgrade-required-offline-session-describe`. Worker slow-header timing and MCP
slow-header/request expiry (including the MCP neighbour timers row and closing
paragraph) are closed by the real Node expiry test. The dispositions' final
matrix obligation is the 21 cells above. The API reserve deferral was already
closed by the real-provider reserve test above. Client peer verification remains
outside D1a, owned by a separate client hardening/interface decision; no new
client peer verifier has been built. D1c still owns cross-request cancellation
and coordination-session binding, which this stateless read does not implement.
No accepted D1a gate clause is deferred to those future workflows.

## Plan conflict resolved by the lead

The final Gate quotes the D1a-5a refusal-only API cookie ordering, but D1a-5b
subsequently mounted supported API cookies with a shared initiating slot,
admission and provider resolution. On 2026-11-20 the lead directed this audit to
treat 5a as a historical intermediate gate. Its four rows retain explicit
no-body/no-budget/no-admission/no-provider assertions on legacy API and the
unix, worker and MCP mounts. In open/token API mode, and better-auth without a
configured public origin/cookie boundary, the body is not read; mint uses
admission before refusing `credential_in_open_mode`,
`credential_not_accepted_here` and `invalid_credential` respectively. Those
configurations do not use provider resolution or an initiating provider slot;
the separate acceptance row asserts that ordering. Supported API cookie behavior is proved by
the later cookie conformance and real-provider tests. This is a documented plan
clarification, not a production defect or an expected-failure test.


The disclosure row uses real SQLite human session/evidence and agent credential
rows. The provider request resolver is controlled; verification/revalidation
read the owned SQL adapter. Responses include headers, bodies, SDK results,
JSON-RPC errors and real CLI stdout/stderr on socket and offline paths.
Diagnostics include the composition logs port, every MCP diagnostic callback,
MCP snapshots and adapter console sinks. The `wts_<uuid>_<secret>` public token
part embeds the credential row UUID; that exact substring is checked too.
CLI and unix operators have no wrong/revoked credential path; unix credential
probes assert `credential_on_local_listener` instead. The CLI refusal is a real
post-runner release refusal on socket and `unknown_mode` offline. Cookie wrong
and revoked session probes assert `invalid_credential`.

Restore handoff evidence distinguishes malformed content from unreadability.
The unreadable case uses a valid handoff record. It checks mode 000 on
non-root runs. On every host it also injects EACCES at `openSync` for that
file and asserts that the denial occurred.
