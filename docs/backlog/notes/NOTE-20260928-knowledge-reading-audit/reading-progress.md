# Knowledge reading: stage 2 progress

PR: https://github.com/pioootrek/worktree-switcher/pull/59

Merged on 2026-09-28 as `3ac66f9` after green verification on `68f30b7`.

## Delivered behavior

Imported notes show provenance-backed summaries, their documents, and a secondary
original-payload disclosure. Native JSON and edited bodies remain ordinary text.
Markdown, UTF-8 text and raster files open in the authorized note context, with
separate byte-preserving download. Sibling links resolve only known relative
paths; unsupported, invalid, oversized or inaccessible files have explicit states.
No schema migration, reimport or persistent-body rewrite is included.

Document URLs support reload and Back. Selected documents use compact note context
so the document body gets the main reading area. File lists show paths, extensions
and size instead of generic octet-stream MIME. The existing shadcn preset remains.

## Pilot evidence

The owner-authorized isolated pilot ran through the managed server on the reading
integration worktree. Source/layout revision for these screenshots: `656718c`.
Later focus and refresh corrections passed the regression verification below;
the screenshot layout is unchanged.

- Desktop PL/dark note and document: 1440 CSS pixels wide.
- Mobile PL/dark document: 390 by 844, no page-wide horizontal overflow.
- Desktop EN/light: 1440 by 900, and short viewport 1440 by 600.
- Real Chromium 200% zoom: physical viewport 1440 by 900, CSS viewport 720 by
  450, device pixel ratio 2; no page-wide horizontal overflow. Captured through
  CDP without clipping. This is a reflow check, not a complete accessibility audit.
- A real sibling link opened database-portability.md; browser Back restored
  implementation-plan.md. A copied document URL loaded the document after sign-in.
- The original implementation-plan.md downloaded as 34,728 bytes. SHA-256 matched
  authorized attachment metadata:
  `3bc5f4fb83245b94d0233099f7dcf9f47e27d79051eae59556e9f6d40e4fba8d`.
- Cross-note/source-repository links remain explicitly unavailable; this stage
  resolves authorized siblings only. Wide tables/code have local scroll regions.

![Imported note](reading-screenshots/final-note-desktop-pl.png)
![Document, desktop](reading-screenshots/final-document-desktop-pl.png)
![Document, mobile](reading-screenshots/final-document-mobile-pl.png)
![Document, English light](reading-screenshots/final-document-desktop-en-light.png)
![Short viewport](reading-screenshots/final-document-short-en-light.png)
![Real 200% zoom](reading-screenshots/final-document-200pct-en-light.png)

## Verification and review

Final application source `c2c0e58`: managed check
`344d2fad-c4bb-4b2d-83cd-2b6fb1956a80` passed (495 unit tests and 7 resource
checks), and build `d13965da-1c5e-4a3a-8f3c-6ef6becb57f1` passed. The final
commit `68f30b7` changes only the refresh regression fixture. Managed UI run
`82e15cdb-04e5-4906-8836-501310bde8cb` passed all 102 tests on that revision.
Completed managed runs reported matching clean source observations at enqueue,
preflight and finish. Initial failed checks and interrupted runs are not passing
evidence.

n8n review was dispatched once for all reviewers. Claude stopped at its session
limit and did not review. Kimi and Codex published their findings. Two valid
concerns were fixed and verified: mobile return focus and same-scope refresh
tearing down an open document. The path-regex concern was rejected with a direct
source-pattern reproduction and a passing real-import regression for
`Assets/Plan_V1.md`. All three published threads have replies and are resolved.
The new browser regression checks an unrelated-project event and concurrent
same-project revalidation, unchanged bytes/focus/scroll, changed content, removal
and denied access.

The first CI attempt on `c2c0e58` failed in the unchanged multi-project switching
integration test: the switch operation reported an occupied port. One rerun
passed integration, then exposed the same incorrect one-listing-per-event
assumption as local UI. The test-only correction waits for all pending metadata
requests without weakening the byte-fetch, focus or scroll assertions. Final CI
on `68f30b7` passed: [Verify run 36449727795](https://github.com/pioootrek/worktree-switcher/actions/runs/36449727795),
including check/build, HTTPS, integration, UI, E2E, package smoke on Node 22.23.2
and 24.21.0, and packaged systemd service lifecycle.

The managed preview remains on the reading integration worktree, port 3001;
the claim was released without stopping it. Last HTTP check returned 200.

## Owner follow-up

After this slice, discuss why Markdown exists in imported Knowledge and whether
it should be the intended content format. The owner explicitly deferred that
discussion; this slice does not decide or migrate the data model. The broader GUI
rework remains open for the subsequent agreed scopes.
