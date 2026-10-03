import { writeFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** Shared production-prefix provisioning; callers own finite commands and cleanup. */
export async function productionInstallEnvironment(root, environment = process.env) {
  const forwarded = Object.fromEntries([
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "npm_config_registry",
  ].flatMap(name => environment[name] ? [[name, environment[name]]] : []));
  const env = { PATH: environment.PATH, LANG: "C.UTF-8", ...forwarded,
    npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty-npmrc"), npm_config_globalconfig: join(root, "empty-global-npmrc") };
  await Promise.all([writeFile(env.npm_config_userconfig, ""), writeFile(env.npm_config_globalconfig, "")]);
  return env;
}
export async function installProductionPrefix(tarball, prefix, root, env, run) {
  await run("npm", ["install", "--global", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: root, env, timeout: 300_000 });
  return join(prefix, "lib", "node_modules", "worktree-switcher");
}
export async function installedSqlite(packageRoot) {
  const sqliteRoot = join(packageRoot, "node_modules", "better-sqlite3");
  const sqlite = await import(pathToFileURL(join(sqliteRoot, "lib", "index.js")));
  const database = new sqlite.default(":memory:"); database.exec("select 1"); database.close();
  const binding = await import(pathToFileURL(join(sqliteRoot, "lib", "binding.js")));
  const prebuilt = binding.default.getPrebuildPath(), addon = prebuilt ?? join(sqliteRoot, "build", "Release", "better_sqlite3.node");
  return { Database: sqlite.default, binary: relative(packageRoot, await realpath(addon)), provisioning: prebuilt ? "packaged prebuilt" : "npm lifecycle source build" };
}
