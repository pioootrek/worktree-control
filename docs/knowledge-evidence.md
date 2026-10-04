---
audience: "operators and agents preparing Knowledge evidence"
last_reviewed: "2026-10-04"
source_of_truth: "Knowledge attachment admission and evidence preparation contract"
status: "active"
---

# Knowledge capacity and evidence

All attachment admission uses one installation policy: Hub import planning and
publication, ordinary attachment writes and logical project import/export.
Defaults are **10 MiB per file, 512 MiB logical bytes and 5000 attachment
records per project** (MiB = 1048576 bytes). WinPath's known 1300 records /
183705590 bytes leave 3700 records / 353165322 bytes under this policy. This
is approximately three times the observed byte footprint and nearly four
times the record count; the diagnostic 200 MiB / 2000 values are not defaults.

Each attachment record charges its complete decoded size, even when another
record or project references the same SHA-256 object. Archived parent records
still count. Logical quota does not report disk allocation or free disk space:
objects can be shared across projects and failed writes can retain durable
unreferenced objects. Removing worktrees or archiving tasks frees no quota.

Existing attachments, history and links are preserved without migration.
Reads and downloads remain authorized even above the configured limits or on
archived projects. New writes and transfers must fit the policy; an identical
committed upload retry does not charge again. Lowering policy does not delete
data. A project above policy can use full-controller backup, or an operator
can review the supported installation policy before a logical export.
Deletion and retention are separate planned stages and are not implemented here.

## Installation configuration

An optional `knowledge-policy.json` in the controller's data directory overrides
individual defaults. All values are positive integers in bytes or records:

```json
{"fileBytes":10485760,"projectBytes":536870912,"projectFiles":5000}
```

Unknown fields, invalid values and files over 4096 bytes fail configuration
loading. Supported upper bounds are 10 MiB per file, 1 GiB per project and
10000 records; fileBytes must not exceed projectBytes. This preserves the
bounded base64 transport (14,100,000-byte request), rather than accepting an
upload the transports cannot carry. The running controller reads the file once
at startup; offline Hub and transfer CLI commands read the same file. There is
no agent mutation tool for policy. Editing/restarting a live installation is
an operator action, outside an evidence upload workflow.

Independent resource envelopes remain: logical transfer metadata is limited to
64 MiB, its manifest to 4 MiB; Hub source planning allows the project record
limit plus 5000 source files and project byte limit plus 64 MiB for source
metadata, with 10 MiB per source file. These source limits include configuration,
documents and schema files, not just attachments. Admission still checks the
logical attachment records with the common policy. Publication includes other
existing attachments and subtracts only records actually replaced by that
import; removed source paths do not delete old evidence.

## Application operations

HTTP `POST /api/knowledge`, MCP and the `knowledge` CLI share validated operations:

| Operation | Inputs | Result / permission |
| --- | --- | --- |
| `attachment_policy` | `projectId` | `limits`, `used`, `largestFileBytes`, `remaining`, `exceeded`; `attachments:read`, archived reads allowed |
| `check_attachment_batch` | `projectId`, `recordKind`, `recordId`, `files`, optional `evidence` | whole-set `accepted`, `incoming`, `violations`, `replayedFiles`, `policy`; current `attachments:read` and `attachments:write` |
| `create_attachment` | existing upload fields | immutable attachment and `replayed`; current `attachments:write` |

MCP names have the `knowledge_` prefix. A policy result explicitly declares
`accounting: "logical_attachment_records"` and `physicalDiskUsage: null`.
Remaining capacity clamps to zero; exceeded values remain visible.

A preflight manifest contains 1–10000 entries, unique `filename`, positive
integer `size` in decoded bytes and lowercase 64-character `sha256`. Requests
are bounded to 4 MiB. With both `mediaType` and `idempotencyKey`, preflight can
exclude an identical committed retry for the same actor, project and target.
It rejects conflicting keys or declared sizes inconsistent with saved content.
The manifest declares content; it cannot verify bytes that have not arrived.

Preflight returns all file and project violations for the combined set. It
reserves no capacity (`reservesCapacity: false`), and uploads are separate
operations (`atomicUpload: false`). Recheck after changes. Upload repeats
authorization and current byte/count admission inside the metadata transaction;
concurrent requests cannot charge beyond policy. The singleton database owner
and synchronous immediate transactions remain the coordination boundary.

Upload requires project/target, basename filename (1–255 characters, no slash,
backslash or control characters), mediaType, canonical padded RFC 4648 base64
without a data URL, and stable `idempotencyKey` (1–200 characters). `sha256` is
optional for existing clients; when supplied it must match the computed hash.
Empty decoded payload is `invalid_request`, even when the project is full.
Retry the same fields and content with the same key after an uncertain response.
Changed content or target under that key gives `idempotency_conflict`.

Quota write errors retain `code: "limit_exceeded"` and `error`, with additive
`details.violations[]`: `constraint` (`fileBytes`, `projectBytes`, `projectFiles`),
`used`, `limit`, `incoming`, `remaining`, `unit` (`bytes` or `records`) and
filename for file violations. `details.recovery` describes reducing incoming
evidence, rerunning preflight, operator policy review within supported bounds,
or full-controller backup. It does not propose an unavailable deletion tool.
HTTP returns 413; MCP returns the same failure object with `isError`; CLI
preserves the structured JSON in its error.

## Evidence bundle contract

Existing generic attachments need no new metadata. When declaring an evidence
bundle through preflight, every `evidence` field is mandatory:

| Field | Meaning |
| --- | --- |
| `setId` | Stable identifier shared by the report and screenshots |
| `taskId` | Existing task in this project; must match the attachment target |
| `commit` | Full lowercase 40- or 64-digit Git commit SHA |
| `command` | Actual command executed, including relevant arguments |
| `result` | `passed`, `failed`, `interrupted` or `inconclusive` |
| `executedAt` | ISO 8601 execution timestamp with time zone |
| `scope` | What the evidence confirms and what verification was omitted |

Use `recordKind: "task"` and store a JSON report containing `evidence` and the
artifact manifest as an attachment to that task. Include `setId` in report
and screenshot filenames. The report is a durable, exportable ordinary
attachment; preflight metadata itself is not persisted and does not prove a
command ran. Describe fixture browser tests as fixture evidence, rather than
production verification. Failed/stopped processes never prove completion.

Recommended: compress images before hashing, capture only useful views,
include command output and exit status in the report, and give each artifact
its own stable upload key. These recommendations are not additional admission
requirements. Never put credentials in filenames, reports or screenshots.

The dashboard's project-level **Attachment capacity** disclosure presents the
same policy in Polish and English, including exact byte counts, remaining
records, exceeded constraints and read-access errors. It refreshes from the
existing Knowledge change signal and adds no subscription or polling timer.
