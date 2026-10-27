# Experiment: task current state before history

**Review status: proposed, awaiting owner review.** This experiment is not an
approved visual contract or a production component.

Purpose: show how a Knowledge task reader could put the current result, open
blocker, next step, owner decision, evidence and separate delivery facts above
the description and history. It accompanies the design in
[docs/knowledge-current-state-design.md](../../../docs/knowledge-current-state-design.md)
(Knowledge task `6cc7e676-d699-482b-b907-5832249eda70`).

Reference: the [approved image](../../approved-project-worktrees.png) and the
working [tokens](../../tokens.css). The palette is copied inline so that
`index.html` opens alone. It reuses the charcoal surfaces, the small uppercase
panel label, state words with icons, monospaced commits and lime for selection
and the primary action only. Nothing is taken from WinPath.

## Use

Open `index.html` directly in a browser; no server, network or build is needed.
The controls above the mocked application choose:

- scenario A–I from the design's acceptance table, plus, for scenario E, the
  approval method (none, installation token, owner session) and the consent
  policy (current: the installation token counts as the owner, per the owner's
  2026-10-27 decision; future: owner session only);
- PL or EN, dark or light, and desktop 1440, mobile 390 or mobile 320.

The freshness chip, the **Needs attention** list and the owner-consent wording
come from the `assess()` function in the page. It implements the design's
finding table, so the fixtures contain recorded state and facts, not
hand-written verdicts. Source links simulate navigation to a record and
**Back to task state** returns focus to the originating link. **Go to history**
moves focus to the history heading. All content is fictional.

## Checks performed (2026-10-27)

Repeated after the consent-policy change: all 12 scenario E combinations of
approval method, policy and language rendered the expected wording.

- `node --check` on the extracted script passed.
- A Node harness with a stubbed DOM ran `assess()` for every scenario and
  rendered all 7 scenarios × PL/EN × 3 widths without placeholders,
  `undefined` or object text. Assessment results:
  A, B and D have no findings; C has `done_with_open_blocker`,
  `evidence_missing`, `ci_not_merged_head` and `claim_without_source`;
  E has `consent_missing` without approval, no finding when approved under
  the current policy, and `consent_method_not_accepted` for an
  installation-token approval under the future policy;
  F is `changed_since` with 5 changes, `source_inactive` and `next_step_on_done`;
  G is `missing`.
- A browser preview of scenario D at 1440 px (dark, PL) was inspected. It
  revealed that a `hidden` control remained visible, which was fixed, and that
  the list did not collapse in narrow embeds, which now matches the app.

Not verified: full keyboard traversal in a real browser, screen-reader output,
200 % zoom and the light theme's contrast. These checks belong to the
production component's acceptance in the implementation slice.

Review fixes: scenarios H and I cover an unknown blocker list and two open
blockers with different actors, conditions and sources. Arrays remain the
known representation, including `[]` for confirmed absence. Unknown is never
rendered as an all-clear; every open blocker is shown without a disclosure.

After these fixes, the Node harness passed all 54 combinations (A–I × PL/EN ×
desktop/mobile/narrow) and checked that H never says "No open blockers", I
contains both blockers and their actors/conditions, and unknown blockers do
not trigger `blocked_without_blocker`. Script syntax and docs fmt/check passed.
