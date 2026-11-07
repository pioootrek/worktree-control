/** Shared by the controller's generation store and the separate static server process. */
export const SERVED_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
/** Extensions a Godot Web export legitimately serves; anything else is never copied or served. */
export const SERVED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(SERVED_MIME_TYPES));
/** Dotfiles, traversal names and characters outside a portable set are refused. */
export const SERVED_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,159}$/;
export const GENERATION_ID = /^[a-z0-9]{1,16}-[a-f0-9]{8}$/;
export const WORKTREE_KEY = /^[a-f0-9]{16}$/;
