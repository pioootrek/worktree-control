/**
 * Browser client injected into exported pages. It only reads the same-origin
 * `/__wtc/events` stream and reloads the whole page after a new complete
 * generation; it is not state-preserving hot reload and carries no credentials.
 *
 * The stream URL names the page's generation (already public in its path). On
 * every connection the server answers whether it still serves that generation:
 * a build from another worktree is left immediately, even with auto-reload off,
 * because after a runtime switch it no longer represents the running worktree.
 * A restart of the same worktree keeps the page. Without auto-reload, a newer
 * build of the same worktree only offers Reload.
 */
export const LIVE_RELOAD_SCRIPT = String.raw`(() => {
  "use strict";
  if (window.__wtcLiveReload) return;
  window.__wtcLiveReload = true;
  const match = location.pathname.match(/^\/g\/([a-z0-9]{1,16}-[a-f0-9]{8})\//);
  const current = match ? match[1] : null;
  const pl = (navigator.language || "").toLowerCase().startsWith("pl");
  const text = pl ? {
    live: "Podgląd na żywo", waiting: "Czekam na pierwszy eksport Web…", building: "Trwa eksport Web…",
    failed: "Eksport nie powiódł się — działa poprzednia wersja", failedFirst: "Eksport nie powiódł się — czekam na poprawny eksport",
    gone: "Ta wersja nie jest już serwowana", ready: "Nowa wersja jest gotowa", reload: "Odśwież",
    auto: "Auto-odświeżanie", hide: "Ukryj", show: "Podgląd", offline: "Brak połączenia z serwerem podglądu",
    region: "Stan podglądu Godot Web"
  } : {
    live: "Live preview", waiting: "Waiting for the first Web export…", building: "Web export in progress…",
    failed: "Export failed — previous build kept", failedFirst: "Export failed — waiting for a successful export",
    gone: "This build is no longer served", ready: "A new build is ready", reload: "Reload",
    auto: "Auto-reload", hide: "Hide", show: "Preview", offline: "Preview server unreachable",
    region: "Godot Web preview status"
  };
  const storage = (key, value) => { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; } return null; };
  let auto = storage("wtc-live-reload-auto") !== "off";
  let latest = null;
  let missing = false;
  let leaving = false;
  const hidden = new URLSearchParams(location.search).get("wtc_overlay") === "0";
  const root = document.createElement("div");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", text.region);
  root.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;color:#f4f4f5;background:rgba(24,24,27,.88);border:1px solid #52525b;border-radius:6px;padding:6px 8px;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 16px);flex-wrap:wrap";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = text.reload;
  reload.hidden = true;
  const label = document.createElement("label");
  label.style.cssText = "display:flex;gap:4px;align-items:center;cursor:pointer";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = auto;
  label.append(toggle, document.createTextNode(text.auto));
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.textContent = text.hide;
  collapse.setAttribute("aria-expanded", "true");
  for (const button of [reload, collapse]) button.style.cssText = "font:inherit;color:inherit;background:#3f3f46;border:1px solid #71717a;border-radius:4px;padding:1px 6px;cursor:pointer";
  root.append(status, reload, label, collapse);
  const go = () => { leaving = true; location.replace("/" + location.search); };
  reload.addEventListener("click", go);
  toggle.addEventListener("change", () => { auto = toggle.checked; storage("wtc-live-reload-auto", auto ? "on" : "off"); if (auto) apply(latest); });
  collapse.addEventListener("click", () => {
    const expanded = collapse.getAttribute("aria-expanded") === "true";
    collapse.setAttribute("aria-expanded", String(!expanded));
    collapse.textContent = expanded ? text.show : text.hide;
    for (const element of [label, reload]) element.style.display = expanded ? "none" : "";
  });
  function apply(state) {
    if (!state || leaving) return;
    latest = state;
    const fresh = state.generation && state.generation !== current;
    if ((fresh || missing) && (!current || auto)) { go(); return; }
    reload.hidden = !(fresh || missing);
    status.textContent = fresh ? text.ready : missing ? text.gone
      : state.build === "building" || state.build === "queued" ? text.building
      : state.build === "failed" ? (current ? text.failed : text.failedFirst) : current ? text.live : text.waiting;
  }
  const mount = () => { if (!hidden) document.body.append(root); };
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
  status.textContent = current ? text.live : text.waiting;
  const events = new EventSource("/__wtc/events" + (current ? "?generation=" + current : ""));
  events.addEventListener("page", (event) => {
    let page = null;
    try { page = JSON.parse(event.data).status; } catch { return; }
    if (page === "foreign") { events.close(); go(); return; }
    missing = page === "missing";
  });
  events.addEventListener("state", (event) => { try { apply(JSON.parse(event.data)); } catch { /* ignore malformed state */ } });
  events.addEventListener("error", () => { if (events.readyState !== EventSource.OPEN) status.textContent = text.offline; });
})();
`;

/** Shown until the first complete generation for the running worktree is published. */
export function placeholderPage(liveReload: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Godot Web preview</title>${liveReload ? '<script src="/__wtc/live-reload.js" defer></script>' : '<meta http-equiv="refresh" content="5">'}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#18181b;color:#e4e4e7;font:14px/1.5 system-ui,sans-serif}</style></head>
<body><main><p>Waiting for the first complete Web export of this worktree.</p><p>Czekam na pierwszy kompletny eksport Web tego worktree.</p></main></body></html>`;
}
