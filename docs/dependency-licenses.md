---
audience: "maintainers preparing public source and package releases"
last_reviewed: "2026-10-05"
source_of_truth: "production dependency license review"
status: "active"
---

# Production dependency license review

Review date: 2026-09-28

The production graph was inspected from the locked pnpm installation with:

```bash
pnpm licenses list --prod --json
```

The review covered 485 package entries across these license identifiers:

| License | Packages |
| --- | ---: |
| MIT | 438 |
| ISC | 19 |
| Apache-2.0 | 11 |
| BSD-3-Clause | 7 |
| BSD-2-Clause | 4 |
| BlueOak-1.0.0 | 2 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| LGPL-3.0-or-later | 1 |
| Python-2.0 | 1 |

The direct runtime dependencies use MIT, ISC, or Apache-2.0 licenses. The
copied shadcn/ui component source is MIT-licensed and its notice is preserved
in `THIRD_PARTY_NOTICES.md`.

The document reader adds `react-markdown@10.1.0` and `remark-gfm@4.0.1`,
both MIT-licensed, with their parsing dependencies included in the counts above.

Three transitive entries need explicit attention during package releases:

- `caniuse-lite@1.0.30001810` contains compatibility data under CC-BY-4.0.
- `@img/sharp-libvips-linux-x64@1.3.3` is an optional platform package under
  LGPL-3.0-or-later. It is installed as a separate package with its own license
  and is not copied into this repository.
- `argparse@2.0.1` uses the Python-2.0 license.

No reviewed license prevents Worktree Control itself from using the MIT
license. Published dependency packages must keep their upstream license files,
and release archives must keep `LICENSE` and `THIRD_PARTY_NOTICES.md`.

Repeat this review when the lockfile changes before a public package release.
