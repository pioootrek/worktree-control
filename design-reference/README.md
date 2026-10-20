# Design reference

Open `index.html` directly in a browser. It uses local files only and needs no
installation, build, development server, API, credentials or network connection.
Keep it beside `docs/` when copying it so the approved image link still works.

Use **Motyw: Ciemny / Jasny** in the header to compare themes. Both share the
lime action fill; light mode uses darker accent text, status colors and focus
rings for contrast. Palette labels follow the active theme. Theme changes keep
the current filters, page, density and selection. Refresh starts in dark mode
unless the browser restores the select value; no preference is persisted by
the catalog. The approved bitmap always retains its original dark appearance.
The light palette is a proposed companion, awaiting visual review.

This directory is a visual reference and experimentation space, separate from
the application. Its HTML specimens describe appearance and interaction ideas;
they are not production shadcn components or a second implementation to import.
The application still owns its React components and behavior.

## What is authoritative

The [owner decision](../docs/knowledge/AGENTS.md) (Knowledge attachment `860fe2f28d0548b78c8227f6b1583b09`)
and its [approved image](../docs/knowledge/AGENTS.md) (Knowledge attachment `c1323b553ff099fab5f6a51f6b3b8b8c`)
are the governing reference. The catalog links to that exact image rather than
creating another copy. WinPath is a process reference only; its appearance must
not be copied.

`tokens.css` and the HTML specimens are **working interpretations**, not newly
approved visual contracts. Adjusting a CSS value does not change the owner's
decision. The catalog labels that distinction visibly.

## Contents

- `index.html`: approved image, palette, typography, controls, states and a
  project-table playground.
- `tokens.css`: semantic working tokens, using names that can later map to
  shadcn variables.
- `catalog.css`: reference-only presentation and comfortable/compact density.
- `catalog.js`: local demonstration data, filtering, pagination and selection.
  Refreshing the page resets the demonstration; it does not control projects.

## How to evolve the design

1. Open the approved image before changing a specimen. Name the question the
   experiment should answer, such as row height or ownership visibility.
2. Make a focused variant. Keep the approved image and recorded decision intact.
   For a larger alternative, use `experiments/YYYY-MM-DD-description/` with a
   short README containing its purpose, reference and review status. Create such
   a directory only when there is an actual experiment to keep.
3. Compare the same content and viewport. Check hover, keyboard focus, selected,
   disabled, loading, error and empty states. Use long names and both languages
   before promoting a design into production.
4. Record screenshots and observations with the experiment. Mark it proposed,
   accepted or rejected, with the owner decision for accepted changes. A screenshot
   alone is not approval or proof of accessibility.
5. Implement an accepted pattern through the application's owned shadcn
   components and tokens in a separate change. Do not import catalog code or
   styles into `src/` or publish the catalog through `public/` or `out/`.

## Manual checks

- Open `index.html` with networking disabled; the reference image and local
  styles should still load.
- Change the theme after filtering and selecting a row. The table state should
  stay unchanged. Check palette labels, button hover, focus, native form controls,
  muted text and warning/error states in both themes. The reference image must
  remain unchanged.
- Switch between 30 and 300 fictional projects and both densities. Search for
  `projekt 029`, use the server-state filter and browse pages. Clear the filters
  and confirm a no-results state is distinguishable from an empty registry.
- Select a row, then change filters or pages. Selection is cleared when its
  row leaves the visible page. No selection starts or switches a server.
- Tab through the controls. Labels, focus and the selected project's name
  should be understandable without color. Try widths of 1440, 1024 and 390px;
  the wide table scrolls in its own labelled region.
- Compare against the approved image. This catalog is a component study, not
  a pixel-exact reproduction of its full project-detail screen.

Initial verification: local paths, image checksum, JavaScript syntax and token
text contrast were checked when created. Browser rendering and interaction
verification remain pending because the session's browser preview was unavailable.

The root package's explicit `files` allowlist excludes this directory. It sits
outside Next.js routes and public assets, with no application imports or build
step. Keep that separation when adding future experiments.
