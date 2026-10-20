# GUI rework design QA

**Source visual truth**

- [Approved reference](design-reference/approved-project-worktrees.png), moved
  unchanged from the retired file backlog.
- Source pixels: 1487 × 1058, 1× density.

**Implementation evidence**

- `test-results/dashboard-1440.png`: browser-rendered fixture at a 1440 × 1000 CSS-pixel viewport; full-page capture is 1440 × 1304 pixels at 1× density.
- `test-results/dashboard-768.png`: browser-rendered responsive fixture at a 768 × 1000 CSS-pixel viewport.
- `test-results/dashboard-390.png`: browser-rendered responsive fixture at a 390 × 1000 CSS-pixel viewport; full-page capture is 390 × 1881 pixels at 1× density.
- `test-results/design-qa-comparison.png`: source and desktop implementation normalized to 720 pixels wide per side for a single combined comparison.
- State: dark theme, one stopped project, selected dirty worktree, no active runtime or reservation.

**Full-view comparison evidence**

The implementation preserves the reference hierarchy: narrow operator navigation, compact utility header, restrained charcoal surfaces, lime selection/action cue, project identity, running-server state before selection, dense worktree table, explicit operation target, and separate verification/status content. The implementation is taller because it retains the existing status, resource, logs, test, storage, reservation, TLS, and environment workflows below the reference's selected tab.

**Focused comparison evidence**

- Typography: Geist Sans and Geist Mono match the reference's readable product/technical split. Long branch and path strings truncate or scroll within their region without shrinking the interface type.
- Spacing/layout: the desktop content grid, sidebar, table rows, quiet dividers, modest radii, and action grouping closely reproduce the approved composition. Mobile removes the persistent sidebar and lets the utility header flow normally so it does not cover content.
- Colors/tokens: foundational shadcn tokens now map to neutral charcoal and a single restrained lime primary; amber, red, and green remain semantic states rather than competing brand colors. Light-mode token support remains present.
- Image quality/assets: the target contains no product photography or custom raster artwork to reproduce. All interface icons use the existing Lucide family; no placeholder, CSS-art, inline-SVG, or generated asset substitutes were introduced.
- Copy/content: new labels explicitly distinguish the running server from the selected operation target in Polish and English.
- Accessibility/interactions: project actions, worktree select, explicit table-row selection, tabs, dialogs, locale switch, focus visibility, long labels, and 390/768/1440 responsive layouts were exercised by the repository Playwright fixture. Its captured page-error list remained empty.

**Findings**

- No actionable P0, P1, or P2 mismatch remains.
- P3: the production screen necessarily carries more operational detail below the fold than the reference mock. This is an acceptable functional extension; the approved above-the-fold hierarchy remains intact.

**Comparison history**

1. Initial desktop comparison found no blocking fidelity issue. Initial mobile capture exposed a P2 sticky utility header that covered content after scrolling.
2. The header was changed to become sticky only at desktop width. The revised 390-pixel browser capture shows a normal-flow mobile header and unobstructed project content.

**Implementation checklist**

- [x] Preserve active-runtime identity independently from selected worktree.
- [x] Show the proposed operation target and transition before action.
- [x] Preserve existing runtime, reservation, verification, storage, settings, and localization behavior.
- [x] Verify desktop, tablet, and mobile layouts and core interactions in a real browser fixture.
- [x] Verify production static export and TypeScript compilation.

final result: passed
