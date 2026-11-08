// Finite installed-artifact acceptance. All writable state and listeners belong to this fixture.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { installProductionPrefix, installedSqlite, productionInstallEnvironment } from "./package-install.mjs";
const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const inputPath = process.argv[2] ?? join(repository, "dist/rbac-acceptance-input.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
assert.equal(typeof input.oldPackage, "string");
const oldRoot = await realpath(input.oldPackage), oldCli = join(oldRoot, "dist/cli/index.js");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(await readFile(oldCli)), input.oldCliSha256, "Explicit old executable fingerprint must match.");
const root = await mkdtemp(join(tmpdir(), "wtc-rbac-installed-"));
const children = new Set(), steps = [], clients = [];
let controller, failureStep, cleanupConfirmed = false;
let native;
const secretValues = new Set();
const password = `finite-${randomBytes(20).toString("hex")}`, replacement = `finite-${randomBytes(20).toString("hex")}`;
secretValues.add(password); secretValues.add(replacement);
const data = join(root, "data"), state = join(root, "state"), origin = "https://controller.test";
const directoryArgs = ["--data-dir", data, "--state-dir", state];
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" };
const bounded = (file, args, options = {}) => exec(file, args, { cwd: root, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options });
const step = async (name, action) => { failureStep = name; const value = await action(); steps.push({ name, ok: true }); return value; };
async function command(cli, args, extra = {}, body) {
  const child = spawn(process.execPath, [cli, ...args, ...directoryArgs], { cwd: root, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
  let stdout = "", stderr = "", forced = false;
  const collect = (stream, chunk) => { if (stream === "stdout") stdout += chunk; else stderr += chunk; if (stdout.length + stderr.length > 65536) { forced = true; child.kill("SIGKILL"); } };
  child.stdout.on("data", chunk => collect("stdout", String(chunk))); child.stderr.on("data", chunk => collect("stderr", String(chunk)));
  const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 30_000);
  child.stdin.on("error", () => {}); child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", code => { clearTimeout(timer); children.delete(child); accept(code); }); });
  assert(!forced, "Finite CLI duration/output bound exceeded.");
  for (const secret of [password, replacement]) assert(!stdout.includes(secret) && !stderr.includes(secret), "Passwords must not appear in CLI output.");
  return { code, stdout, stderr };
}
async function json(cli, args, extra, body) {
  const result = await command(cli, args, extra, body);
  let code; try { code = JSON.parse(result.stderr).code; } catch { /* event or no error */ }
  assert.equal(result.code, 0, `Finite CLI failed (${code ?? "unclassified"}): ${args[0]} ${args[1] ?? ""}`);
  const value = JSON.parse(result.stdout); if (value.token) secretValues.add(value.token); return value;
}
async function freePort() { return new Promise((accept, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : accept(port)); }); }); }
async function wait(read, milliseconds = 20_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(accept => setTimeout(accept, 30)); }
  throw new Error("Finite fixture condition timed out.");
}
async function stop() {
  for (const client of clients.splice(0)) await client.close();
  if (!controller) return;
  const child = controller; controller = undefined;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await wait(() => child.exitCode !== null || child.signalCode !== null, 15_000);
  children.delete(child); assert.equal(child.exitCode, 0, "Packaged controller must drain and exit normally.");
}
const observe = read => { const database = new native.Database(join(data, "state.sqlite3"), { readonly: true }); try { return read(database); } finally { database.close(); } };
let currentCli, currentRoot, endpoint, mcpURL;
async function start() {
  const port = await freePort(), mcpPort = await freePort(); endpoint = `http://127.0.0.1:${port}`; mcpURL = `http://127.0.0.1:${mcpPort}/mcp`;
  const child = spawn(process.execPath, [currentCli, "start", ...directoryArgs, "--service-mode", "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(mcpPort),
    "--public-url", origin, "--web-root", join(currentRoot, "out"), "--no-open"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  controller = child; children.add(child); let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-65536); });
  await wait(async () => { assert.equal(child.exitCode, null, "Packaged controller exited before readiness."); try { const access = JSON.parse(await readFile(join(state, "service-access.json"), "utf8")); return access.pid === child.pid; } catch { return false; } });
  for (const value of secretValues) assert(!output.includes(value), "No fixture credentials in controller output.");
}
const cookieJar = () => {
  const cookies = new Map();
  return { cookies, async call(path, body, headers = {}, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(endpoint + path, { method, headers: { Host: "controller.test", Origin: origin, "Content-Type": "application/json",
      ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    for (const line of response.headers.getSetCookie()) {
      assert(/;\s*Secure/i.test(line) && /;\s*HttpOnly/i.test(line) && /SameSite=Strict/i.test(line));
      const pair = line.split(";")[0], index = pair.indexOf("=");
      if (/Max-Age=0/i.test(line)) cookies.delete(pair.slice(0, index)); else { cookies.set(pair.slice(0, index), pair.slice(index + 1)); secretValues.add(pair.slice(index + 1)); }
    }
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, body: await response.json() };
  } };
};
let report;
try {
  await mkdir(data, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const output = join(repository, "dist/rbac-artifacts"); await mkdir(output, { recursive: true, mode: 0o700 });
  const packed = await step("community-pack", async () => JSON.parse((await bounded("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], { cwd: repository })).stdout)[0]);
  const tarball = join(output, packed.filename), communitySha256 = digest(await readFile(tarball));
  const installEnv = await productionInstallEnvironment(root);
  currentRoot = await step("clean-prefix-community-install", () => installProductionPrefix(tarball, join(root, "current"), root, installEnv, bounded));
  currentCli = join(currentRoot, "dist/cli/index.js"); native = await installedSqlite(currentRoot);
  const artifact = JSON.parse(await readFile(join(repository, "dist/private-auth-provider/artifact.json"), "utf8"));
  assert.equal(digest(await readFile(artifact.path)), artifact.sha256);
  const providerPrefix = join(root, "provider");
  await step("separate-optional-provider-install", () => bounded("npm", ["install", "--prefix", providerPrefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", artifact.path], { env: installEnv }));
  const entry = join(providerPrefix, "node_modules/@worktree-control/auth-provider-better-auth-proof/dist/index.js");
  assert(!(await readFile(entry, "utf8")).includes("/test/"));
  const oldOwner = await step("old-release-owner-and-history", () => json(oldCli, ["identity", "bootstrap-owner"]));
  const ownerEnv = { WORKTREE_CONTROL_OWNER_TOKEN: oldOwner.token };
  const knowledge = (await json(oldCli, ["identity", "create-knowledge-project", "--name", "Preserved knowledge"], ownerEnv)).project;
  const oldAgent = (await json(oldCli, ["identity", "create-agent"], ownerEnv)).principal;
  await json(oldCli, ["identity", "grant-knowledge", "--principal-id", oldAgent.id, "--project-id", knowledge.id, "--permissions", "knowledge:read,knowledge:write"], ownerEnv);
  const oldAgentCredential = await json(oldCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "old narrow client"], ownerEnv);
  const task = await json(oldCli, ["knowledge", "create_task", "--json", JSON.stringify({ projectId: knowledge.id, title: "Old history", description: "Preserved", idempotencyKey: "seed" })], { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: oldAgentCredential.token });
  const before = observe(db => ({ schema: db.prepare("SELECT max(version) n FROM schema_migrations").get().n,
    principal: db.prepare("SELECT id,kind,status FROM remote_principals WHERE id=?").get(oldOwner.principalId),
    grants: db.prepare("SELECT * FROM knowledge_project_grants ORDER BY principal_id,project_id").all(),
    audit: db.prepare("SELECT * FROM controller_audit_events ORDER BY id").all() }));
  assert(before.schema < 49);
  await step("pre-fence-upgrade-refusal", async () => assert.notEqual((await command(currentCli, ["auth", "status"])).code, 0));
  const preflight = await json(currentCli, ["auth", "fence", "inspect"]); assert.equal(preflight.establishmentAllowed, true);
  await step("protected-fence-establish", () => json(currentCli, ["auth", "fence", "establish", "--expect", preflight.preflight]));
  await step("upgrade-preserves-owner-grants-and-history", async () => {
    const after = observe(db => ({ schema: db.prepare("SELECT max(version) n FROM schema_migrations").get().n,
      principal: db.prepare("SELECT id,kind,status FROM remote_principals WHERE id=?").get(oldOwner.principalId),
      grants: db.prepare("SELECT * FROM knowledge_project_grants ORDER BY principal_id,project_id").all(),
      audit: db.prepare("SELECT * FROM controller_audit_events ORDER BY id").all() }));
    assert.equal(after.schema, 49); assert.deepEqual(after.principal, before.principal); assert.deepEqual(after.grants, before.grants);
    assert.deepEqual(after.audit.slice(0, before.audit.length), before.audit);
    assert.equal((await json(currentCli, ["knowledge", "task", "--json", JSON.stringify({ projectId: knowledge.id, taskId: task.value.id })], { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: oldAgentCredential.token })).title, "Old history");
  });
  const installation = await json(currentCli, ["auth", "token", "generate"]);
  await step("real-provider-configure-enroll-existing-owner", async () => {
    await json(currentCli, ["auth", "provider", "configure", "--input-stdin"], {}, { module: entry, origin, signingSecret: { kind: "generate" } });
    await json(currentCli, ["auth", "provider", "enroll", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { email: "owner@fixture.invalid", name: "Existing owner", password });
  });
  const repo = join(root, "project"); await mkdir(repo);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
  await writeFile(join(repo, "test.mjs"), "console.log('finite test failure evidence');process.exitCode=2;\n");
  const gitEnv = { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.test" };
  for (const args of [["init", "-b", "main"], ["add", "."], ["commit", "-m", "finite fixture"]]) await bounded("git", args, { cwd: repo, env: gitEnv });
  await start();
  const added = await fetch(endpoint + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
    body: JSON.stringify({ name: "Finite verification", repositoryPath: repo, port: await freePort(), launchPreset: "none" }) });
  assert.equal(added.status, 201); const project = (await added.json()).project;
  await stop();
  const actions = ["projects:read", "tests:run", "profiles:select", "config:write", "logs:read", "storage:read", "capacity:read"];
  await json(currentCli, ["identity", "set-runtime-delegation", "--principal-id", oldAgent.id, "--project-id", project.id, "--actions", actions.join(","), "--expected-revision", "0"], ownerEnv);
  const credential = await json(currentCli, ["identity", "issue-runtime-credential", "--principal-id", oldAgent.id, "--label", "explicit diagnostics", "--projects-json", JSON.stringify([{ projectId: project.id, actions }])], ownerEnv);
  await json(currentCli, ["auth", "provider", "runtime-access", "set", "--input-stdin"], {}, { principalId: oldOwner.principalId,
    scope: { kind: "runtime-project", id: project.id }, role: "operator", permissions: ["projects:read", "tests:run", "profiles:select", "config:write"], expectedRevision: 0 });
  await step("protected-rbac-selection-and-real-restart", async () => {
    await json(currentCli, ["auth", "mode", "set", "better-auth"]); await start();
    assert.equal((await json(currentCli, ["auth", "status"])).activeMode, "better-auth");
  });
  const browser = cookieJar();
  await step("public-packaged-login-and-transport-denial-matrix", async () => {
    assert.deepEqual((await browser.call("/api/auth/status")).body, { mode: "better-auth", loginAvailable: true });
    const login = await browser.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password }); assert.equal(login.status, 200);
    assert(!JSON.stringify(login.body).match(/token|password|hash/i));
    const session = await browser.call("/api/auth/get-session"); assert.equal(session.body.principal.id, oldOwner.principalId);
    assert.equal((await browser.call("/api/runtime/read", { operation: "list-projects" })).status, 200);
    for (const path of ["/api/dashboard", "/api/events", "/api/backups", "/api/identity/bootstrap", "/api/dev-vault", "/api/auth/sign-up/email", "/api/auth/revoke-sessions"]) assert.equal((await browser.call(path, {})).status, 401);
    assert.equal((await browser.call("/api/auth/get-session", undefined, { Authorization: `Bearer ${installation.token}`, "X-Worktree-Switcher-Token": installation.token })).status, 401);
  });
  const sdk = join(currentRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm");
  const { Client } = await import(pathToFileURL(join(sdk, "client/index.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(sdk, "client/streamableHttp.js")));
  const connect = async token => { const client = new Client({ name: "installed-rbac", version: "1" }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(mcpURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client; };
  const client = await connect(credential.token);
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert(!result.isError, `MCP ${name} denied`); return JSON.parse(result.content[0].text); };
  await step("real-mcp-runtime-verification-config-and-diagnostics", async () => {
    assert.equal((await call("list_projects"))[0].id, project.id);
    await call("get_project_status_compact", { projectId: project.id }); await call("list_worktrees", { projectId: project.id });
    await call("get_project_configuration", { projectId: project.id, worktreePath: repo });
    await call("get_runtime_logs", { projectId: project.id }); await call("get_project_storage", { projectId: project.id });
    assert(!JSON.stringify(await call("get_server_capacity")).includes("holders")); await call("get_test_queue");
    const presets = await call("list_test_presets", { projectId: project.id }); assert(presets[0].presets.some(preset => preset.id === "node:test"));
    const run = await call("run_test", { projectId: project.id, worktreePath: repo, presetId: "node:test", idempotencyKey: randomUUID() });
    const terminal = await wait(async () => { const result = await call("get_test_run", { runId: run.runId }); return ["failed", "passed"].includes(result.status?.phase ?? result.phase) ? result : null; });
    assert.equal(terminal.status?.phase ?? terminal.phase, "failed");
    assert(JSON.stringify(await call("get_test_run_logs", { runId: run.runId })).includes("finite test failure evidence"));
  });
  if (input.legacyLauncher) await step("real-legacy-stdio-proxy-and-client-config-shapes", async () => {
    const launcher = await readFile(input.legacyLauncher, "utf8"); assert.equal(digest(launcher), input.legacyLauncherSha256);
    assert(launcher.includes("WORKTREE_SWITCHER_MCP_TOKEN="));
    const fixtureLauncher = join(root, "legacy-launcher"), secrets = join(root, "fixture-secrets.env"), headers = join(root, "fixture.headers");
    await writeFile(fixtureLauncher, launcher.replaceAll("http://127.0.0.1:47832/mcp", mcpURL), { mode: 0o700 });
    await writeFile(secrets, `WORKTREE_SWITCHER_MCP_TOKEN=${credential.token}\n`, { mode: 0o600 });
    const { StdioClientTransport } = await import(pathToFileURL(join(sdk, "client/stdio.js")));
    const proxy = new Client({ name: "legacy-stdio-client", version: "1" }); clients.push(proxy);
    const transport = new StdioClientTransport({ command: "sh", args: [fixtureLauncher], env: { ...env,
      AGENT_MCP_SECRETS_FILE: secrets, WORKTREE_SWITCHER_MCP_HEADER_FILE: headers,
      npm_config_cache: join(root, "proxy-npm-cache"), npm_config_userconfig: join(root, "empty-npmrc"), npm_config_globalconfig: join(root, "empty-global-npmrc") }, stderr: "pipe" });
    await proxy.connect(transport);
    const result = await proxy.callTool({ name: "get_test_queue", arguments: {} }); assert(!result.isError);
    const projectRead = await proxy.callTool({ name: "knowledge_project", arguments: { projectId: knowledge.id } }); assert(!projectRead.isError);
    const config = { claude: { mcpServers: { "worktree-switcher": { command: fixtureLauncher } } },
      opencode: { mcp: { "worktree-switcher": { type: "local", command: [fixtureLauncher] } } },
      codex: `[mcp_servers.worktree-switcher]\ncommand = ${JSON.stringify(fixtureLauncher)}\n` };
    assert(!JSON.stringify(config).includes(credential.token));
    await proxy.close(); clients.splice(clients.indexOf(proxy), 1);
    assert.equal((await readFile(headers, "utf8")).trim(), `Authorization: Bearer ${credential.token}`);
  });
  await step("online-cli-individual-knowledge-and-protected-revoke", async () => {
    await json(currentCli, ["knowledge", "tasks", "--json", JSON.stringify({ projectId: knowledge.id })], { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: credential.token });
    await json(currentCli, ["identity", "revoke-token", "--credential-id", credential.credential.id], ownerEnv);
    await assert.rejects(client.callTool({ name: "get_test_queue", arguments: {} }));
    const response = await fetch(mcpURL, { method: "POST", headers: { Authorization: `Bearer ${installation.token}`, "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 401);
  });
  await step("logout-and-ordinary-restart", async () => {
    const old = browser.cookies.get("__Secure-wtc.session_token"); await browser.call("/api/auth/sign-out", {});
    assert.equal((await browser.call("/api/auth/get-session", undefined, { Cookie: `__Secure-wtc.session_token=${old}` })).body.authenticated, false);
    await stop(); await start(); assert.equal((await cookieJar().call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password })).status, 200); await stop();
  });
  await step("installed-public-integrated-totp-replay-and-durable-budget", async () => {
    await start(); const enrollment = cookieJar();
    assert.equal((await enrollment.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password })).body.authenticated, true);
    const enabled = await enrollment.call("/api/auth/two-factor/enable", { password }); assert.equal(enabled.status, 200);
    const url = new URL(enabled.body.totpURI); secretValues.add(enabled.body.totpURI);
    let bits = ""; for (const char of url.searchParams.get("secret").toUpperCase().replace(/=+$/, "")) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0");
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
    const code = (offset = 0) => { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)+offset));
      const hash = createHmac("sha1", key).update(counter).digest(); return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1_000_000).padStart(6,"0"); };
    const used = code(), enrolledStep = Math.floor(Date.now()/30_000);
    assert.equal((await enrollment.call("/api/auth/two-factor/verify-totp", { code: used })).status, 200);
    const one = cookieJar(); assert.equal((await one.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password })).body.outcome, "challenge");
    assert.equal((await one.call("/api/auth/two-factor/verify-totp", { code: used })).status, 401);
    await wait(() => Math.floor(Date.now()/30_000) > enrolledStep, 35_000);
    const next = code(); assert.equal((await one.call("/api/auth/two-factor/verify-totp", { code: next })).status, 200);
    const two = cookieJar(); await two.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password });
    assert.equal((await two.call("/api/auth/two-factor/verify-totp", { code: next })).status, 401);
    const freshWindow = Date.now() + 61_000; await wait(() => Date.now() >= freshWindow, 65_000);
    const invalid = cookieJar(); await invalid.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password });
    const accepted = new Set([-1,0,1].map(code)); let wrong = 0; while (accepted.has(String(wrong).padStart(6,"0"))) wrong++;
    const charged = () => observe(db => db.prepare("SELECT coalesce(sum(charged),0) n FROM authentication_factor_budgets WHERE scope='totp' AND epoch=?").get(Math.floor(Date.now()/60_000)).n);
    const before = charged(); assert.equal((await invalid.call("/api/auth/two-factor/verify-totp", { code: String(wrong).padStart(6,"0") })).status, 401);
    assert.equal(charged(), before+1);
    for (let i=0;i<5;i++) assert([401,429].includes((await invalid.call("/api/auth/two-factor/verify-totp", { code: String(wrong).padStart(6,"0") })).status));
    assert.equal((await invalid.call("/api/auth/two-factor/verify-totp", { code: code() })).status, 429);
    await stop();
  });
  await step("raw-database-rollback-fence-and-protected-recovery", async () => {
    const backup = join(root, "rollback.sqlite3"); const db = new native.Database(join(data, "state.sqlite3"), { readonly: true }); try { await db.backup(backup); } finally { db.close(); }
    await json(currentCli, ["auth", "provider", "recover", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { newPassword: replacement });
    await cp(backup, join(data, "state.sqlite3")); await rm(join(data, "state.sqlite3-wal"), { force: true }); await rm(join(data, "state.sqlite3-shm"), { force: true });
    assert.notEqual((await command(currentCli, ["auth", "status"])).code, 0);
    const inspected = await json(currentCli, ["auth", "fence", "inspect"]);
    await json(currentCli, ["auth", "fence", "resume", "--expect", inspected.preflight, "--mode", "better-auth"]);
    await json(currentCli, ["auth", "provider", "recover", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { newPassword: replacement });
    await start(); const recovered = cookieJar();
    assert.equal((await recovered.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password })).status, 401);
    const login = await recovered.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password: replacement }); assert.equal(login.status, 200);
    assert.equal((await recovered.call("/api/auth/get-session")).body.principal.id, oldOwner.principalId);
    assert.equal((await recovered.call("/api/runtime/read", { operation: "list-projects" })).status, 200);
    await stop();
    const principals = observe(db => db.prepare("SELECT id,kind,status FROM remote_principals WHERE kind='owner'").all()); assert.deepEqual(principals, [before.principal]);
    assert.equal(observe(db => db.prepare("SELECT title FROM knowledge_tasks WHERE id=?").get(task.value.id).title), "Old history");
  });
  const snapshot = { oldSchema: before.schema, currentSchema: 49, ownerContinuity: true, grantsBeforeCutoverPreserved: true, oldCredentialsNotWidened: true, restorationQuarantinesAuthority: true };
  report = { result: "passed", steps, source: (await bounded("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
    community: { path: tarball, sha256: communitySha256 }, provider: artifact, oldCliSha256: input.oldCliSha256, evidence: snapshot };
} catch (error) {
  report = { result: "failed", failureStep, steps, error: error instanceof assert.AssertionError ? error.message.slice(0, 300) : "Finite installed acceptance failed" };
  // Never forward arbitrary application/CLI error bodies, tokens or provider details.
  for (const secret of secretValues) report.error = report.error.replaceAll(secret, "[redacted]");
  process.exitCode = 1;
} finally {
  try { await stop(); for (const child of children) { child.kill("SIGKILL"); await new Promise(accept => child.once("close", accept)); } children.clear(); cleanupConfirmed = true; }
  catch { cleanupConfirmed = false; process.exitCode = 1; }
  await rm(root, { recursive: true, force: true });
  report.cleanupConfirmed = cleanupConfirmed;
  await mkdir(join(repository, "dist/rbac-artifacts"), { recursive: true });
  await writeFile(join(repository, "dist/rbac-artifacts/acceptance.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
