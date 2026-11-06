import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ProjectLaunchCommandResolver } from "../server/launch-command";
import { GodotWebService, type GodotWebServiceOptions } from "../server/modules/godot-web";

/**
 * Connects the bundled static-server entrypoint (a sibling of the CLI bundle,
 * or its TypeScript source through tsx in a checkout) to the launch resolver.
 */
export function createGodotWebRuntime(stateDirectory: string, options: Omit<GodotWebServiceOptions, "storeRoot" | "commands">) {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(sourceMode ? "./godot-web-server.ts" : "./godot-web-server.js", import.meta.url));
  // The resolver needs the service's store layout; the service needs the resolver.
  const holder: { service?: GodotWebService } = {};
  const commands = new ProjectLaunchCommandResolver({
    executable: process.execPath,
    // A runtime cwd is the game worktree, so the tsx loader is passed by absolute URL.
    args: [...(sourceMode ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : []), entry],
    publicDirectory: (projectId) => holder.service!.publicDirectory(projectId),
  });
  const godotWeb = new GodotWebService({ ...options, storeRoot: join(stateDirectory, "godot-web"), commands });
  holder.service = godotWeb;
  return { commands, godotWeb };
}
