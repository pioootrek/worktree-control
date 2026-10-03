# S5c installed-artifact acceptance contract — 2026-10-03

Status: accepted implementation direction; execution starts after S5b merge.

No S5c code before S5b merge. One existing worker, finite foreground fixtures only; no host systemd or production keys/data/destination.

1. Pin historical reference a727fd8ff01e141c6494615531e27e72a23f6320 (schema24, existing package:trial), explicitly not a claim about current production. Create clean isolated historical checkout, use its discovered WTS build preset and original lockfile; package with its existing package:trial command. Pin new artifact to the S5c test commit and use the same distribution tooling. Record both source commits, dirty=false, Node/platform/native provision and tarball SHA256. Never patch a historical package to claim it is exact a727. Where packaging has no queue preset, use its supported finite command sequentially; no second packer.

2. Extend the accepted installed-driver hook to receive an explicit old artifact plus checksum/provenance. Reuse/extract the existing production-prefix installer instead of copying it. Old/new prefixes are separate, both clean installs with production dependencies only. All app operations and dashboard assets come from their installed artifacts; repository fixture driver is separately identified. The historical schema24/legacy identity behavior is exercised through the historical CLI/HTTP, not by copying a modern schema fixture.

3. Seed historical runtime with two knowledge projects, owner/agent identities and distinct scoped grants, tasks/discussion replies/relations, mutations/history/audit and attachment bytes+hashes. Save expected IDs/content and check tenant denial before and after upgrade. Create a real historical full installation backup. Stop old foreground owner cleanly before new startup on the same fixture DB; verify automatic pre-migration copy, schema upgrade, all business records/history/attachments/identities and relevant authorization fences. Read schema/counts only with stopped owners and installed dependency/readonly connection. Never start old runtime on a migrated new DB; historical releases cannot be retroactively assumed to enforce modern downgrade guards.

4. Fault injection operates only through an explicit trusted fixture wrapper around the installed CLI (no production runtime fault switches): kill before migration and after durable pre-migration publication; interrupt current owned restore before/after replacement and verify replay preserves one complete generation. If extra injection cannot safely target a built bundle, reuse syscall interception in a local fixture wrapper with bounded child supervision and disclose that boundary. Assert refused unsupported/corrupt artifacts/source/manifest and occupied canonical owner without overwriting active data.

5. Recovery outside source SQLite ledger: transfer a new artifact full snapshot into disposable authenticated HTTPS restic, verify it, remove the original fixture installation+local copies, restore to a fresh private directory and validate records/history/attachments/access with installed runtime. Also restore the schema24 pre-migration/historical backup into an isolated old-runtime data directory to prove historical recovery, without in-place downgrade. Capture exactly which credentials are preserved or invalidated by the existing restore security fence.

6. Reusable sanitized evidence/runbook/S6 procedure: artifact/source IDs, schema versions, source-deleted proof, hashes/counts/authorization results, simulated crash boundary and elapsed isolated recovery. No tokens, paths to secrets, repository credentials or raw remote errors. Durable report plus a repeatable finite CLI procedure records unmeasured real-host/offsite RPO/RTO and the separate target/key/rollout decisions. Existing CI lifecycle/service acceptance remains separate; llm-worker services are untouched.

Confirmed implementation boundaries:

- Seed only capabilities actually supported by the historical runtime. Record
  their coverage explicitly; never substitute a modern database for historical
  artifact behavior.
- Cover both default-off upgrade (no automatic copies/jobs or destination
  requirement) and an enabled pre-migration backup gate.
- Exercise representative installed-artifact crash boundaries and reference
  earlier comprehensive crash matrices rather than repeat every existing test.
- Preserve and account for writes made after upgrade before testing rollback.
  Recover an old snapshot into a separate directory before starting old code.
- Use and report a normal historical-runtime umask. Do not conceal compatibility
  failures by silently changing fixture data or file permissions.
- Repository scripts are test drivers; application behavior comes from exact
  installed artifacts. Keep this distinction in every acceptance report.
