// Bundled static server for the godot-web preset. Worktree Control starts it as an
// owned runtime with PORT; it reads only the project's published generations.
import { resolve } from "node:path";

import { GodotWebStaticServer, WORKTREE_KEY } from "../server/infrastructure/godot-web";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = option("--root");
const worktreeKey = option("--worktree-key") ?? "";
const port = Number(process.env.PORT);
if (!root) throw new Error("godot-web-server requires --root.");
if (!WORKTREE_KEY.test(worktreeKey)) throw new Error("godot-web-server requires a valid --worktree-key.");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be supplied by Worktree Control (1024-65535).");

const server = new GodotWebStaticServer({
  root: resolve(root),
  worktreeKey,
  liveReload: option("--live-reload") !== "0",
  isolation: option("--isolation") !== "0",
});
const host = process.env.HOST || "0.0.0.0";
await server.listen(port, host);
console.log(`Godot Web preview listening on port ${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
}
