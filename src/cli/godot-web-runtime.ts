import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProjectLaunchCommandResolver } from "../server/launch-command";
import { GodotWebService, type GodotWebServiceOptions } from "../server/modules/godot-web";

/**
 * Connects the bundled static-server entrypoint (a sibling of the CLI bundle,
 * or its TypeScript source through tsx in a checkout) to the launch resolver.
 */
export function createGodotWebRuntime(stateDirectory: string, options: Omit<GodotWebServiceOptions, "storeRoot" | "commands">) {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(sourceMode ? "./godot-web-server.ts" : "./godot-web-server.js", import.meta.url));
  let godotWeb: GodotWebService | undefined;
  const commands = new ProjectLaunchCommandResolver({
    executable: process.execPath,
    args: [...(sourceMode ? ["--import", import.meta.resolve("tsx")] : []), entry],
    publicDirectory: (projectId) => godotWeb!.publicDirectory(projectId),
  });
  godotWeb = new GodotWebService({ ...options, storeRoot: join(stateDirectory, "godot-web"), commands });
  return { commands, godotWeb };
}
