---
audience: "people previewing Godot Web exports through Worktree Control and contributors changing that runtime"
last_reviewed: "2026-11-06"
source_of_truth: "godot-web launch preset, export configuration, publication and live reload"
status: "active"
---

# Godot Web preview

The `godot-web` launch preset serves a Godot project's Web export on the
project's stable port, rebuilds it while you edit, and reloads the page after
each complete export. It is an explicit opt-in. Automatic detection still
registers a root `project.godot` as the verification-only `none` preset, and
existing projects are never migrated.

Live reload restarts the game. It is not hot module replacement: scene state,
game progress and the WebAssembly heap are lost on every reload. Editor
scene and script synchronization belongs to the Godot editor's debugging
tools and is unrelated to Web export.

## How it works

1. Starting the project runs a small static server bundled with Worktree
   Control as the managed runtime. It is an owned process group on the
   project's port, subject to the usual claim, capacity and stop rules. The game
   repository needs no `package.json`.
2. While that runtime is running, the controller watches the configured source
   paths in the selected worktree and queues an export after a quiet period.
3. Every export is a finite job in the shared test queue (preset ID
   `godot:web-export`). It respects the global parallel limit, per-worktree
   exclusion, cancellation, the preset timeout and the assigned test environment
   profile. At most one export per preview is queued or running, and changes
   that arrive meanwhile collapse into a single follow-up.
4. After the exporter exits successfully, the controller copies the output into
   a new immutable generation and switches the served pointer atomically. A
   failed, cancelled or timed-out export leaves the previous generation in place.
5. The browser receives a server-sent event and reloads the whole page. The
   overlay can disable automatic reload for a gameplay session; a **Reload**
   button then appears when a newer build is ready.

Stopping or switching the runtime ends the watcher and event stream, cancels
that preview's export through the queue, and suppresses publication of any
export that completes afterwards. A generation is bound to the worktree that
produced it: after a switch, the previous worktree's build is not served.

## Configure an exporter

Choose one exporter. Both run without a shell, from the worktree root.

### Standard Godot export preset

```json
{
  "exporter": { "kind": "preset", "preset": "Web", "godotExecutable": "godot" }
}
```

The controller runs `godot --headless --path <worktree> --export-release
"Web" <staging>/index.html`, writing into a controller-owned staging directory
rather than the worktree. Create the Web preset in the Godot editor first
(`export_presets.cfg`). `godotExecutable` is a program on `PATH` or an absolute
path on this installation. Install export templates that match the engine
version. Worktree Control never installs or upgrades Godot or its templates;
missing prerequisites fail the export with Godot's own message in the run log.

### Project-owned export command

Use this when the project prepares its export itself, for example when it stages
a subset of assets, runs import steps, checks the pack, or wraps a host-specific
resource guard:

```json
{
  "exporter": {
    "kind": "command",
    "command": ["bash", "scripts/project.sh", "export-web"],
    "outputDirectory": "exports/web"
  },
  "watch": { "paths": ["game", "scenes", "assets", "project.godot"], "ignore": [] }
}
```

The first argument is a program on `PATH` or a worktree-relative executable
script; the remaining arguments are passed unchanged. The command must leave
a complete flat Web export with `index.html` at the root of `outputDirectory`,
inside the worktree. A wrapper may delegate to a heavy-task runner or other
resource guard that the host requires; the queue still owns the outer process
group and timeout.

### Common options

| Field | Default | Meaning |
| --- | --- | --- |
| `watch.paths` | `["."]` | Directories (recursive) or files to watch, relative to the worktree |
| `watch.ignore` | `[]` | Extra ignored prefixes |
| `watch.debounceMs` | `750` | Quiet period before an export is queued |
| `liveReload` | `true` | Inject the reload overlay and event stream |
| `crossOriginIsolation` | `true` | Send COOP/COEP headers |

`.git`, `.godot`, `.import`, editor directories, `node_modules`, the output
directory and paths that Git ignores in the worktree are never watched.
Use a `.gitignore` entry or `watch.ignore` for any other directory an exporter
writes into. When sources change during three exports in a row, automatic
rebuilds pause, because that usually means the exporter writes into a
watched path. **Export again** resumes them.

## Set it up

Dashboard: open the project's **Godot Web settings**, choose the exporter and
save while the server is stopped. **Disable Godot Web** returns the project to
verification-only. Registration also offers the **Godot Web** preset; it starts
with the standard `Web` preset configuration.

CLI (files contain the JSON shown above):

```bash
worktree-control project add /path/to/game --preset godot-web --godot-web-config godot-web.json
worktree-control project godot-web <project-id> --config godot-web.json
worktree-control project godot-web <project-id> --disable
worktree-control project rebuild-web <project-id>
```

HTTP: `POST /api/projects/<id>/godot-web` with `{"config": {...}}` or
`{"config": null}`, `POST /api/projects/<id>/godot-web/rebuild`, and
`GET /api/projects/<id>/godot-web`. MCP: `configure_godot_web`,
`rebuild_web_export` and `get_web_export_status`; `get_project_status` also
includes `webExport`. Configuration changes require a stopped server and
respect existing reservations.

## Serving and security

- The static server answers `GET` and `HEAD` only. It serves files from
  published generations, never the worktree, and only regular files with
  allowlisted Web extensions (`.html`, `.js`, `.wasm`, `.pck`, images, audio,
  fonts, `.json`, `.css`, `.txt`, `.webmanifest`). Dotfiles, symlinks, encoded
  traversal and malformed URLs are refused. Publication copies files with
  `O_NOFOLLOW` and skips everything else.
- `/` redirects to `/g/<generation>/`. All relative resources of one page load
  come from that immutable generation, so a reload during publication cannot
  mix two builds. Generation assets are cached as immutable; HTML and state
  are `no-cache`/`no-store`.
- The current generation and its most recent predecessor are retained. A generation is
  limited to 4,096 files, 1 GiB and nesting depth 8.
- Served pages receive only an opaque generation ID and coarse build state.
  No controller token, path, log line or control endpoint is exposed on the
  game's port. Build logs remain in the dashboard's test run view.
- The preview binds `0.0.0.0` unless `HOST` is set in the project environment.

## Threads and secure contexts

With `crossOriginIsolation` on, pages are sent with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. A thread-enabled Web export also
needs a secure context: `http://localhost` or `http://127.0.0.1` qualifies, but
plain HTTP from a LAN address or local hostname does not, and managed HTTPS is
not available for this preset. Use a single-threaded export (the Godot 4.3+
default) when testing from another device. Disable progressive web app
options in the Web preset; a service worker can serve stale builds.

## Source evidence

A preview may intentionally serve a dirty development worktree. Process success
is not clean-source verification: exports of uncommitted changes are recorded
as test runs whose process passed but whose source attribution is `uncertain`,
and the dashboard labels such a build. Edits made after an export starts
supersede its output; the controller discards it and exports again instead of
publishing a build that may mix old and new files.

## Limits and acceptance status

- The source watcher is an explicit exception to the controller's
  no-recursive-watcher policy. It exists only while a `godot-web` runtime is
  running, uses one non-recursive watcher per directory, skips symlinks and
  ignored paths, and falls back to manual export above 4,096 directories.
- Exports run the full Godot export each time; there is no incremental pack.
- Automated tests cover configuration, migration, queue hooks, the watcher,
  publication, the static server and the controller workflow with a fake
  exporter. Exporting a real Godot project and checking live reload in a
  browser still need manual acceptance on a host with matching templates.

See the [Godot 4.7 Web export guide](https://docs.godotengine.org/en/4.7/tutorials/export/exporting_for_web.html)
for preset options and browser requirements.
