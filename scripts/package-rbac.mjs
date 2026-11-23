// Finite installed-artifact acceptance. All writable state and listeners belong to this fixture.
import assert from "node:assert/strict";
import { acceptanceError, failureReport } from "./package-rbac-report.mjs";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { installProductionPrefix, installedSqlite, productionInstallEnvironment } from "./package-install.mjs";
import { PUBLIC_BASELINE, verifyPublicBaseline } from "./package-artifact.mjs";
import { assertReleasePair, PROVIDER_RELEASE_FILES, shrinkwrapClosure } from "./provider-release.mjs";
const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
// Baselines: `public-0.1.1` (default) fetches the exact registry release and checks
// its pinned digests; `fresh` installs only the candidate; a positional JSON file
// selects an explicitly fingerprinted installed historical package.
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const legacyInput = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
const input = legacyInput ? JSON.parse(await readFile(legacyInput, "utf8")) : {};
const baseline = legacyInput ? "historical-installed" : argument("--baseline") ?? `public-${PUBLIC_BASELINE.version}`;
assert(["historical-installed", `public-${PUBLIC_BASELINE.version}`, "fresh"].includes(baseline), "Unsupported baseline.");
const CURRENT_SCHEMA = 53;
const reportPath = resolve(argument("--report") ?? join(repository, "dist/rbac-artifacts", `acceptance-${baseline}.json`));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
let oldRoot, oldCli;
if (baseline === "historical-installed") {
  assert.equal(typeof input.oldPackage, "string");
  oldRoot = await realpath(input.oldPackage); oldCli = join(oldRoot, "dist/cli/index.js");
  assert.equal(digest(await readFile(oldCli)), input.oldCliSha256, "Explicit old executable fingerprint must match.");
}
const root = await mkdtemp(join(tmpdir(), "wtc-rbac-installed-"));
const children = new Set(), steps = [], clients = [], operationsMatrix = [];
const EXPECTED_OPERATIONS_MATRIX_KEYS = [
  "api-bearer/open",
  "api-bearer/token",
  "api-bearer/better-auth",
  "api-cookie/open",
  "api-cookie/token",
  "api-cookie/better-auth",
  "unix/open",
  "unix/token",
  "unix/better-auth",
  "worker-tls/open",
  "worker-tls/token",
  "worker-tls/better-auth",
  "mcp/open",
  "mcp/token",
  "mcp/better-auth",
  "cli-socket/open",
  "cli-socket/token",
  "cli-socket/better-auth",
  "cli-offline/open",
  "cli-offline/token",
  "cli-offline/better-auth"
];
const operationRefusal = (reason, category = "unauthenticated", status = 401, retry = "reauthenticate") => ({ error: { category, status, reason, retry, effect: null } });
const mutationRefusal = (reason, category, status, retry = "none", effect = "not_started") => ({ error: { category, status, reason, retry, effect } });
const matrixCell = (surface, mode, actor, listener, refusal, step) => operationsMatrix.push({ surface, mode, actor, listener, refusal, step });
let controller, cleanupConfirmed = false;
let native, operationsSdk, storedOwner;
const secretValues = new Set();
const password = `finite-${randomBytes(20).toString("hex")}`, replacement = `finite-${randomBytes(20).toString("hex")}`;
secretValues.add(password); secretValues.add(replacement);
const data = join(root, "data"), state = join(root, "state"), origin = "https://controller.test";
let directoryArgs = ["--data-dir", data, "--state-dir", state];
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" };
const bounded = (file, args, options = {}) => exec(file, args, { cwd: root, env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options });
// Each step records its duration: the hosted runner is about twice as slow as a workstation and
// the job has a 25-minute limit, so the report shows where the time goes.
const step = async (name, action) => {
  process.stderr.write(`rbac acceptance: ${name}\n`);
  const started = performance.now();
  try {
    const value = await action(), ms = Math.round(performance.now() - started);
    steps.push({ name, ok: true, ms }); process.stderr.write(`rbac acceptance: ${name} done in ${ms} ms\n`); return value;
  } catch (error) {
    const safe = acceptanceError(error);
    steps.push({ name, ok: false, ms: Math.round(performance.now() - started), error: safe });
    process.stderr.write(`rbac acceptance: ${name} failed: ${safe}\n`);
    throw error;
  }
};
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
/** A refused CLI call: exit code 1 and the JSON error body on the last line of stderr. */
async function refusal(cli, args, extra) {
  const result = await command(cli, args, extra);
  assert.equal(result.code, 1, `Expected a refusal: ${args[0]} ${args[1] ?? ""}`);
  return JSON.parse(result.stderr.trim().split("\n").at(-1));
}
/**
 * A CLI opening refused by the security fence: exit code 1 and, as the last stderr line, the
 * product's SecurityFenceError message for exactly that code ("<code>: Use protected offline auth
 * fence inspect, ..."); outside `auth fence` the CLI prints fence refusals as that text, not JSON.
 */
async function fenceRefusal(cli, args, code, extra) {
  const result = await command(cli, args, extra);
  assert.equal(result.code, 1, `Expected a fence refusal: ${args[0]} ${args[1] ?? ""}`);
  const last = result.stderr.trim().split("\n").at(-1);
  assert(last.startsWith(`${code}: Use protected offline auth fence inspect`), `${args[0]} must be refused with ${code}`);
}
/** The database and its WAL (a missing and an empty WAL are the same state), the witness and the upgrade plan file, each by its bytes. */
async function sourceFiles(directory = directoryArgs[1]) {
  const read = async path => { try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const wal = await read(join(directory, "state.sqlite3-wal")), witness = await read(join(directory, "state.sqlite3.security", "witness.json"));
  const plan = await read(join(directory, "state.sqlite3.upgrade", "plan.json"));
  return { database: digest(await readFile(join(directory, "state.sqlite3"))), wal: wal && wal.length ? digest(wal) : "empty",
    witness: witness ? digest(witness) : "missing", plan: plan ? digest(plan) : "missing" };
}
const UPGRADE_REQUIRED = { code: "upgrade_required", error: "upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.",
  nextStep: "upgrade inspect", state: "upgrade_needed" };
/** Whether anything accepts a connection on the loopback port: true, or false only for a refused connection; any other error fails the step. */
const accepting = port => new Promise((accept, reject) => { const socket = createConnection({ port, host: "127.0.0.1" });
  socket.once("connect", () => { socket.destroy(); accept(true); }); socket.once("error", error => error.code === "ECONNREFUSED" ? accept(false) : reject(error)); });
/**
 * The product's authentication refusal of a bearer credential: status 401 with the server's own JSON
 * body (over MCP, the JSON-RPC error of an invalid bearer token). A request that does not reach the
 * product throws, and any other status or body fails the step.
 */
async function credentialRejected(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }), text = await response.text();
  assert.equal(response.status, 401, `A revoked or pre-upgrade credential must be rejected by authentication (${url}).`);
  const body = JSON.parse(text);
  if (url === mcpURL) assert.deepEqual(body.error, { code: -32000, message: "A valid MCP bearer token is required." });
  else assert.equal(typeof body.error, "string", "The refusal is the controller's own JSON error body.");
}
/** The knowledge endpoint's refusal of an agent credential that no longer authenticates. */
async function knowledgeCredentialRejected(token, projectId) {
  const rejected = await cookieJar().call("/api/knowledge", { operation: "tasks", input: { projectId } }, { Authorization: `Bearer ${token}` });
  assert.equal(rejected.status, 401); assert.equal(rejected.body.code, "invalid_credential");
}
async function freePort() { return new Promise((accept, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : accept(port)); }); }); }
async function wait(read, milliseconds = 20_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(accept => setTimeout(accept, 30)); }
  throw new Error("Finite fixture condition timed out.");
}
async function stop() {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  if (!controller) return;
  const child = controller; controller = undefined;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await wait(() => child.exitCode !== null || child.signalCode !== null, 15_000);
  children.delete(child); assert.equal(child.exitCode, 0, "Packaged controller must drain and exit normally.");
}
const observe = read => { const database = new native.Database(join(directoryArgs[1], "state.sqlite3"), { readonly: true }); try { return read(database); } finally { database.close(); } };
let currentCli, currentRoot, endpoint, mcpURL, workerPort, workerCa, storedWorker;
/**
 * The real Git repositories of the fixture (set while seeding): the linked registration's repository (`main`) with one
 * linked worktree (`feature`, dirty), and the neighbouring registration's repository. After an upgrade `projectId` and
 * `neighbourProjectId` are the projects the operator's accepted links attach them to; in the fresh lane both stay null.
 */
let repositories = null;
/** Every caller and surface that read the real repositories, and whether it was permitted. */
const repositoryEvidence = [];
async function start(cli = currentCli, assets = currentRoot) {
  const port = await freePort(), mcpPort = await freePort(); endpoint = `http://127.0.0.1:${port}`; mcpURL = `http://127.0.0.1:${mcpPort}/mcp`;
  const workerArgs = [];
  if (cli === currentCli) {
    const key = join(root, "worker.key"), cert = join(root, "worker.crt"), config = join(root, "worker-listener.json");
    if (!workerCa) {
      await bounded("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert,
        "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
      workerCa = await readFile(cert);
    }
    workerPort = await freePort();
    await writeFile(config, JSON.stringify({ version: 1, listener: { host: "127.0.0.1", port: workerPort, keyFile: key, certFile: cert } }));
    workerArgs.push("--remote-verification-config", config);
  }
  const child = spawn(process.execPath, [cli, "start", ...directoryArgs, ...workerArgs, "--service-mode", "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(mcpPort),
    "--public-url", origin, "--web-root", join(assets, "out"), "--no-open"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  controller = child; children.add(child); let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-65536); });
  await wait(async () => { assert.equal(child.exitCode, null, "Packaged controller exited before readiness."); try { const access = JSON.parse(await readFile(join(directoryArgs[3], "service-access.json"), "utf8")); return access.pid === child.pid; } catch { return false; } });
  for (const value of secretValues) assert(!output.includes(value), "No fixture credentials in controller output.");
}
/** Gate module evaluation on stdin EOF so the parent closes the pipe before the CLI can write.
 * The real packaged entry point and native descriptors are used, with a 15s process deadline.
 */
async function closedSessionOutput(path, closedStderr) {
  const gate = "data:text/javascript," + encodeURIComponent("await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });");
  const child = spawn(process.execPath, ["--import", gate, currentCli, "session", "describe", ...directoryArgs], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "", forced = false;
  const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 15_000);
  const result = new Promise((accept, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
  });
  try {
    if (!closedStderr) child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.length > 65536) { forced = true; child.kill("SIGKILL"); }
    });
    const close = stream => new Promise(accept => { stream.once("close", accept); stream.destroy(); });
    await close(child.stdout);
    if (closedStderr) await close(child.stderr);
    child.stdin.on("error", () => {}); child.stdin.end();
    const { code, signal } = await result;
    assert(!forced, `${path}: closed output must finish within 15s`); assert.equal(signal, null);
    assert.equal(code, 1, `${path}: closed output must exit 1`);
    assert(!/(?:^|\n)\s+at |node:internal|Unhandled ['"]error['"] event/.test(stderr), `${path}: no unhandled-error stack`);
    if (closedStderr) assert.equal(stderr, "");
    else assert.deepEqual(JSON.parse(stderr.trim().split("\n").at(-1)), {
      error: { category: "unavailable", status: 503, reason: "output_unavailable", retry: "none", effect: null },
    });
    if (path === "offline") {
      assert(!existsSync(join(directoryArgs[3], "controller.lock")), "Offline cleanup removes the controller lock before process close");
      assert(!existsSync(join(directoryArgs[1], "state.sqlite3.owner.lock")), "Offline cleanup removes the database owner lock");
      const database = new native.Database(join(directoryArgs[1], "state.sqlite3"));
      try { database.prepare("BEGIN IMMEDIATE").run(); database.prepare("ROLLBACK").run(); } finally { database.close(); }
      // A second ordinary CLI opening also verifies store/fence admission after the failed write.
      const reopened = await json(currentCli, ["session", "describe"]); assert.equal(reopened.listener, "offline");
    }
  } finally { clearTimeout(timer); children.delete(child); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

async function operationSocket(mode) {
  return step(`operations-unix-${mode}`, async () => {
    const callSocket = headers => new Promise((accept, reject) => {
      const call = httpRequest({ socketPath: join(directoryArgs[3], "admin.sock"), path: "/api/operations/session.describe", method: "POST", headers: { "Content-Type": "application/json", ...headers } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => { try { accept({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      call.setTimeout(10_000, () => call.destroy(new Error("Operations socket deadline"))); call.on("error", reject); call.end("{}");
    });
    const denied = await callSocket({ Authorization: `Bearer ${storedOwner}` });
    assert.equal(denied.status, 401); assert.deepEqual(denied.body, operationRefusal("credential_on_local_listener"));
    for (const [headers, reason] of [[{ Origin: origin }, "browser_headers_on_unix"], [{ Cookie: "__Secure-wtc.session_token=invalid" }, "provider_cookie_not_supported"]]) {
      const reply = await callSocket(headers); assert.equal(reply.status, 401); assert.deepEqual(reply.body, operationRefusal(reason));
    }
    const reply = await callSocket({});
    assert.equal(reply.status, 200); assert.equal(reply.body.actor.kind, "operator"); assert.equal(reply.body.listener, "unix"); assert.equal(reply.body.mode, mode);
    const success = await command(currentCli, ["session", "describe"]);
    assert.equal(success.code, 0); assert.equal(success.stdout, `${JSON.stringify(reply.body, null, 2)}\n`);
    // D2a through the private socket: the operator lists every project; the CLI prints the same released DTO.
    const ids = observe(db => db.prepare("SELECT id FROM knowledge_projects ORDER BY id").all().map(row => row.id));
    const projects = await json(currentCli, ["projects", "list", "--limit", "100"]);
    assert.deepEqual(projects.items.filter(item => item.projectId !== null).map(item => item.projectId), ids);
    const projectStatus = await json(currentCli, ["projects", "status", ids[0]]); assert.equal(projectStatus.projectId, ids[0]); assert.equal(projectStatus.writable, true);
    const projectWorktrees = await json(currentCli, ["projects", "worktrees", ids[0]]); assert.equal(projectWorktrees.projectId, ids[0]);
    assert.deepEqual(await refusal(currentCli, ["projects", "status", "missing-project"]), operationRefusal("resource_not_found", "not_found", 404, "none"));
    // D2b-2 through the private socket: the operator writes a thread with a key and replays it; the CLI replays the same DTO.
    const thread = { projectId: ids[0], title: `Installed unix ${mode} thread`, body: "Written through the private socket." }, threadKey = `installed-unix-${mode}`;
    const writeThread = () => new Promise((accept, reject) => {
      const call = httpRequest({ socketPath: join(directoryArgs[3], "admin.sock"), path: "/api/operations/knowledge.create_thread", method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": threadKey } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => { try { accept({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      call.setTimeout(10_000, () => call.destroy(new Error("Operations socket deadline"))); call.on("error", reject); call.end(JSON.stringify(thread));
    });
    const written = await writeThread();
    assert.equal(written.status, 200); assert.equal(written.body.thread.createdBy, "installation"); assert.equal(written.body.thread.title, thread.title);
    assert.deepEqual(await writeThread(), written);
    assert.deepEqual(await json(currentCli, ["knowledge", "threads", "create", "--project", thread.projectId, "--title", thread.title, "--body", thread.body, "--idempotency-key", threadKey]), written.body);
    assert.equal(observe(db => db.prepare("SELECT count(*) AS n FROM knowledge_threads WHERE title=?").get(thread.title).n), 1);
    await repositoryReads(`cli-socket/${mode}`, cliRead, true);
    for (const closedStderr of [false, true]) await step(`session-describe-unix-${mode}-closed-stdout${closedStderr ? "-and-stderr" : ""}`,
      () => closedSessionOutput("socket", closedStderr));
    const socket = join(directoryArgs[3], "admin.sock"), hidden = socket + ".hidden";
    await rename(socket, hidden);
    try {
      const refused = await refusal(currentCli, ["session", "describe"]);
      assert.deepEqual(refused, { error: { category: "unavailable", status: 503, reason: "admin_socket_missing", retry: "none", effect: null } });
    } finally { await rename(hidden, socket); }
    matrixCell("unix", mode, "operator", "unix", "credential_on_local_listener", `operations-unix-${mode}`);
    matrixCell("cli-socket", mode, "operator", "unix", "admin_socket_missing (CLI has no credential input)", `operations-unix-${mode}`);
  });
}
async function operationOffline(mode) {
  return step(`operations-offline-${mode}`, async () => {
    const dto = await json(currentCli, ["session", "describe"]);
    assert.equal(dto.actor.kind, "operator"); assert.equal(dto.actor.accountId, null);
    assert.equal(dto.listener, "offline"); assert.equal(dto.mode, mode);
    assert.equal(dto.freshLogin.state, "exempt");
    assert(!JSON.stringify(dto).match(/sessionId|credentialId|verifierHash/));
    // D2a offline: the same operator reads under the controller lock; no managed server runs offline.
    const projects = await json(currentCli, ["projects", "list"]);
    for (const item of projects.items) for (const registration of item.registrations) assert.equal(registration.phase, "stopped");
    assert.deepEqual(projects.items.filter(item => item.projectId !== null).map(item => item.projectId),
      observe(db => db.prepare("SELECT id FROM knowledge_projects ORDER BY id").all().map(row => row.id)).slice(0, 50));
    // D2b-2 offline: no retention, so an unkeyed write runs and a keyed one answers idempotency_unavailable before any effect.
    const offlineThread = ["knowledge", "threads", "create", "--project", firstProjectId(), "--title", `Installed offline ${mode} thread`, "--body", "Written offline."];
    const offlineWritten = await json(currentCli, offlineThread);
    assert.equal(offlineWritten.thread.createdBy, "installation"); assert.equal(offlineWritten.thread.title, `Installed offline ${mode} thread`);
    // The keyed refusal: exit 1, the error alone on stderr (the complete stream is its one serialized line), nothing on stdout.
    const offlineKeyed = await command(currentCli, [...offlineThread, "--idempotency-key", `installed-offline-${mode}`]);
    assert.equal(offlineKeyed.code, 1); assert.equal(offlineKeyed.stdout, "");
    assert.equal(offlineKeyed.stderr, `${JSON.stringify(mutationRefusal("idempotency_unavailable", "unavailable", 503))}\n`);
    assert.equal(observe(db => db.prepare("SELECT count(*) AS n FROM knowledge_threads WHERE title=?").get(`Installed offline ${mode} thread`).n), 1);
    for (const closedStderr of [false, true]) await step(`session-describe-offline-${mode}-closed-stdout${closedStderr ? "-and-stderr" : ""}`,
      () => closedSessionOutput("offline", closedStderr));
    matrixCell("cli-offline", mode, "operator", "offline", "not applicable: no credential input; mode-independent upgrade-required-offline-session-describe step covers the released-baseline refusal once", `operations-offline-${mode}`);
  });
}
async function operationWorker(mode, secret) {
  return step(`operations-worker-${mode}`, async () => {
    const call = (secret, headers = {}) => new Promise((accept, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: workerPort, ca: workerCa, path: "/api/operations/session.describe", method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => { try { accept({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      request.setTimeout(10000, () => request.destroy(new Error("Worker operations deadline"))); request.on("error", reject); request.end("{}");
    });
    const reply = await call(secret); assert.equal(reply.status, 200); assert.equal(reply.body.mode, mode); assert.equal(reply.body.listener, "worker");
    assert.equal(reply.body.actor.kind, mode === "better-auth" ? "agent" : "installation");
    {
      const refused = await call(storedWorker ?? storedOwner); assert.equal(refused.status, 401);
      assert.deepEqual(refused.body, { error: { category: "unauthenticated", status: 401, reason: mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here", retry: "reauthenticate", effect: null } });
    }
    if (mode !== "open") { const missing = await call(); assert.equal(missing.status, 401); assert.deepEqual(missing.body, operationRefusal("credential_required")); }
    const cookie = await call(undefined, { Cookie: "__Secure-wtc.session_token=invalid" });
    assert.equal(cookie.status, 401); assert.deepEqual(cookie.body, operationRefusal("provider_cookie_not_supported"));
    matrixCell("worker-tls", mode, mode === "better-auth" ? "agent" : "installation", "worker", mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here", `operations-worker-${mode}`);
  });
}
async function operationMcp(mode, secret) {
  return step(`describe-rpc-${mode}`, async () => {
    // Same stateless JSON-RPC requests as the authentication guide; also keep the real SDK client below.
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "authority-example", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_describe", arguments: {} } },
    ]) {
      const response = await fetch(mcpURL + "/operations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(message) });
      assert.equal(response.status, 200); const reply = await response.json(); assert.equal(reply.id, message.id); assert.equal(reply.error, undefined);
      if (message.method === "initialize") assert.equal(reply.result.protocolVersion, "2025-03-26");
      if (message.method === "tools/list") assert.deepEqual(reply.result.tools.map(tool => tool.name), ["knowledge_create_thread", "project_list", "project_status", "project_worktrees", "session_describe"]);
      if (message.method === "tools/call") { assert.equal(reply.result.structuredContent.listener, "mcp"); assert.equal(reply.result.structuredContent.mode, mode); assert.equal(reply.result.structuredContent.actor.kind, mode === "better-auth" ? "agent" : "installation"); }
    }
    const { Client, StreamableHTTPClientTransport } = operationsSdk;
    const client = new Client({ name: "installed-operations", version: "1" }); clients.push(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpURL + "/operations"), { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {} } }));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["knowledge_create_thread", "project_list", "project_status", "project_worktrees", "session_describe"]);
      const result = await client.callTool({ name: "session_describe", arguments: {} });
      const denied = await client.callTool({ name: "session_describe", arguments: { actor: "operator" } });
      assert.equal(denied.isError, true); assert.deepEqual(denied.structuredContent, operationRefusal("unexpected_input", "invalid_request", 400, "none"));
      assert(!result.isError); const dto = result.structuredContent;
      assert.equal(dto.mode, mode); assert.equal(dto.listener, "mcp"); assert.equal(dto.actor.kind, mode === "better-auth" ? "agent" : "installation");
      // D2a: the agent of the installed fixture holds no role after the authority reset; installation authority lists every project.
      const listed = await client.callTool({ name: "project_list", arguments: {} });
      assert(!listed.isError); assert.deepEqual(listed.structuredContent, await projectReadsExpected(mode, secret));
      const hidden = await client.callTool({ name: "project_status", arguments: { projectId: firstProjectId() } });
      if (mode === "better-auth") { assert.equal(hidden.isError, true); assert.deepEqual(hidden.structuredContent, operationRefusal("resource_not_found", "not_found", 404, "none")); }
      else { assert(!hidden.isError); assert.equal(hidden.structuredContent.projectId, firstProjectId()); }
      const worktrees = await client.callTool({ name: "project_worktrees", arguments: { projectId: "missing-project" } });
      assert.equal(worktrees.isError, true); assert.deepEqual(worktrees.structuredContent, operationRefusal("resource_not_found", "not_found", 404, "none"));
      await repositoryReads(`mcp/${mode}`, toolRead(client), mode !== "better-auth");
    } finally { await client.close(); }
    const threadCall = { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "knowledge_create_thread",
      arguments: { projectId: firstProjectId(), title: `Installed MCP ${mode} thread`, body: "Written over MCP.", idempotencyKey: `installed-mcp-${mode}` } } };
    const callThread = async () => (await fetch(mcpURL + "/operations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(threadCall) })).json();
    const mcpThread = await callThread();
    if (mode === "better-auth") assert.deepEqual(mcpThread, { jsonrpc: "2.0", id: 21, error: { code: -32000, message: "resource_not_found", data: mutationRefusal("resource_not_found", "not_found", 404).error } });
    else {
      assert.equal(mcpThread.result.structuredContent.thread.createdBy, "installation");
      assert.deepEqual(await callThread(), mcpThread);
    }
    for (const name of ["X-Worktree-Control-Token", "X-Worktree-Switcher-Token"]) {
      const refused = await fetch(mcpURL + "/operations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", [name]: secret ?? storedWorker },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      assert.equal(refused.status, 401); assert.equal((await refused.json()).error.reason, "legacy_credential");
    }
    if (mode !== "open") {
      const missing = await fetch(mcpURL + "/operations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(missing.status, 401); assert.deepEqual(await missing.json(), operationRefusal("credential_required"));
    }
    // A stored owner credential exists even before the worker fixture is provisioned.
    const stored = storedWorker ?? storedOwner;
    const refused = await fetch(mcpURL + "/operations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${stored}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "refusal", version: "1" } } }) });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: { category: "unauthenticated", status: 401, reason: mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here", retry: "reauthenticate", effect: null } });
    matrixCell("mcp", mode, mode === "better-auth" ? "agent" : "installation", "mcp", mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here", `describe-rpc-${mode}`);
  });
}
async function operationApi(mode, secret) {
  await operationWorker(mode, secret);
  await operationMcp(mode, secret);
  await operationProjectReads(mode, secret);
  await step(`operations-api-${mode}`, async () => {
    const denied = await fetch(endpoint + "/api/operations/session.describe", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${storedOwner}` }, body: "{}" });
    assert.equal(denied.status, 401); const reason = mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here";
    assert.deepEqual(await denied.json(), operationRefusal(reason));
    if (mode !== "open") {
      const missing = await fetch(endpoint + "/api/operations/session.describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(missing.status, 401); assert.deepEqual(await missing.json(), operationRefusal("credential_required"));
    }
    const reply = await fetch(endpoint + "/api/operations/session.describe", { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: "{}" });
    assert.equal(reply.status, 200); const body = await reply.json(); assert.equal(body.mode, mode); assert.equal(body.listener, "api"); assert.equal(body.actor.kind, mode === "better-auth" ? "agent" : "installation");
    matrixCell("api-bearer", mode, mode === "better-auth" ? "agent" : "installation", "api", reason, `operations-api-${mode}`);
  });
}
/** The first stored Knowledge project, read from the installed database. */
const firstProjectId = () => observe(db => db.prepare("SELECT id FROM knowledge_projects ORDER BY id LIMIT 1").get().id);
/** What project.list releases on this fixture: nothing to a zero-role agent, every project (sorted) to installation authority. */
async function projectReadsExpected(mode, secret) {
  if (mode === "better-auth") return { items: [], nextCursor: null };
  const ids = observe(db => db.prepare("SELECT id FROM knowledge_projects ORDER BY id").all().map(row => row.id));
  const reply = await fetch(endpoint + "/api/operations/project.list", { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: "{}" });
  const body = await reply.json(); assert.deepEqual(body.items.filter(item => item.projectId !== null).map(item => item.projectId), ids);
  return body;
}
async function operationProjectReads(mode, secret) {
  return step(`project-reads-${mode}`, async () => {
    const call = async (id, body, base = endpoint, extra = {}) => {
      const reply = await fetch(base + `/api/operations/${id}`, { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body), ...extra });
      return { status: reply.status, body: await reply.json() };
    };
    const projectId = firstProjectId();
    const listed = await call("project.list", {});
    assert.equal(listed.status, 200); assert.deepEqual(listed.body, await projectReadsExpected(mode, secret));
    const status = await call("project.status", { projectId }), worktrees = await call("project.worktrees", { projectId });
    const missingStatus = await call("project.status", { projectId: "missing-project" }), missingWorktrees = await call("project.worktrees", { projectId: "missing-project" });
    for (const missing of [missingStatus, missingWorktrees]) { assert.equal(missing.status, 404); assert.deepEqual(missing.body, operationRefusal("resource_not_found", "not_found", 404, "none")); }
    if (mode === "better-auth") {
      // A zero-role agent cannot tell an existing project from a missing one.
      assert.deepEqual(status, missingStatus); assert.deepEqual(worktrees, missingWorktrees);
    } else {
      assert.equal(status.status, 200); assert.equal(status.body.projectId, projectId); assert.equal(typeof status.body.revision, "number");
      assert.equal(worktrees.status, 200); assert.deepEqual(Object.keys(worktrees.body).sort(), ["projectId", "registrations", "registrationsTruncated"]);
    }
    const invalid = await call("project.list", { limit: 0 });
    assert.equal(invalid.status, 400); assert.deepEqual(invalid.body, operationRefusal("invalid_limit", "invalid_request", 400, "none"));
    // Project reads are not served on the worker listener in any mode.
    const worker = await new Promise((accept, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: workerPort, ca: workerCa, path: "/api/operations/project.list", method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => { try { accept({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      request.setTimeout(10000, () => request.destroy(new Error("Worker operations deadline"))); request.on("error", reject); request.end("{}");
    });
    assert.equal(worker.status, 404); assert.deepEqual(worker.body, operationRefusal("operation_not_found", "not_found", 404, "none"));
    // D2b-2: the thread write with the Idempotency-Key header, then its replay.
    const apiThread = async () => {
      const reply = await fetch(endpoint + "/api/operations/knowledge.create_thread", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `installed-api-${mode}`,
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ projectId, title: `Installed API ${mode} thread`, body: "Written over the API." }) });
      return { status: reply.status, body: await reply.json() };
    };
    const apiWritten = await apiThread();
    if (mode === "better-auth") assert.deepEqual(apiWritten, { status: 404, body: mutationRefusal("resource_not_found", "not_found", 404) });
    else {
      assert.equal(apiWritten.status, 200); assert.equal(apiWritten.body.thread.createdBy, "installation");
      assert.deepEqual(await apiThread(), apiWritten);
      assert.equal(observe(db => db.prepare("SELECT count(*) AS n FROM knowledge_threads WHERE title=?").get(`Installed API ${mode} thread`).n), 1);
    }
    await repositoryReads(`api-bearer/${mode}`, bearerRead(secret), mode !== "better-auth");
  });
}
/**
 * D2a with a provider cookie: the human's project reads follow their stored roles. After an upgrade the owner holds
 * the installation `admin` role and reads every project; the zero-role agent of the same request matrix sees none of them.
 * D2b-2 with the same cookie: the admin writes a thread through the cookie POST with a key and replays it, attributed to
 * the owner's account (an `owner` principal row, a human account of the target model); without a role the write is not
 * found. An authorized agent write on API or MCP is not demonstrated here: no supported fixture or release command grants
 * an agent a project role yet, so the installed better-auth agent stays the zero-role agent, refused on both.
 */
async function projectReadsAsHuman(browser, accountId, agentToken) {
  const ids = observe(db => db.prepare("SELECT id FROM knowledge_projects ORDER BY id").all().map(row => row.id));
  const admin = observe(db => db.prepare("SELECT count(*) n FROM account_grants WHERE account_id=? AND role='admin' AND scope_kind='installation'").get(accountId).n) === 1;
  const projectId = ids[0];
  const listed = await browser.call("/api/operations/project.list", {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.filter(item => item.projectId !== null).map(item => item.projectId), admin ? ids : []);
  for (const id of ["project.status", "project.worktrees"]) {
    const reply = await browser.call(`/api/operations/${id}`, { projectId }), missing = await browser.call(`/api/operations/${id}`, { projectId: "missing-project" });
    assert.equal(missing.status, 404); assert.deepEqual(missing.body, operationRefusal("resource_not_found", "not_found", 404, "none"));
    if (!admin) { assert.deepEqual(reply, missing); continue; }
    assert.equal(reply.status, 200, `${id} as the installation admin`); assert.equal(reply.body.projectId, projectId);
    if (id === "project.status") { assert.equal(typeof reply.body.revision, "number"); assert.equal(typeof reply.body.writable, "boolean"); }
    else for (const entry of reply.body.registrations) assert(["complete", "partial", "unavailable"].includes(entry.discovery));
  }
  const viaAgent = await fetch(endpoint + "/api/operations/project.status", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ projectId }) });
  assert.equal(viaAgent.status, 404, "The zero-role agent cannot see the project the admin reads.");
  // The admin cookie reads the real repositories; without a role (the fresh lane's owner) the same cookie reads nothing.
  await repositoryReads(admin ? "api-cookie/better-auth/admin" : "api-cookie/better-auth/no-role", (operation, input) => browser.call(`/api/operations/${operation}`, input), admin);
  const writable = observe(db => db.prepare("SELECT id FROM knowledge_projects WHERE status='active' ORDER BY id LIMIT 1").get())?.id;
  assert(writable, "An active project for the cookie thread write.");
  const title = `Installed cookie thread ${admin ? "admin" : "no-role"}`;
  const writeThread = () => browser.call("/api/operations/knowledge.create_thread", { projectId: writable, title, body: "Written with a provider session." },
    { "Idempotency-Key": `installed-cookie-${admin ? "admin" : "no-role"}` });
  const written = await writeThread();
  const stored = () => observe(db => db.prepare("SELECT t.created_by, h.principal_id, h.authentication_method FROM knowledge_threads t JOIN knowledge_history h ON h.record_kind='thread' AND h.record_id=t.id WHERE t.title=?").all(title));
  if (admin) {
    assert.equal(written.status, 200, "The installation admin writes a thread with its cookie.");
    assert.equal(written.body.thread.createdBy, accountId); assert.equal(written.body.thread.projectId, writable); assert.equal(written.body.thread.title, title);
    assert.deepEqual(await writeThread(), written, "The keyed cookie write replays the same answer.");
    assert.deepEqual(stored(), [{ created_by: accountId, principal_id: accountId, authentication_method: "provider_session" }]);
  } else {
    assert.deepEqual(written, { status: 404, body: mutationRefusal("resource_not_found", "not_found", 404) });
    assert.deepEqual(stored(), []);
  }
}
/**
 * Two registrations of real Git repositories, made with the seeding version's own interfaces only: the linked registration
 * (its repository on `main` and one linked worktree on `feature`, whose tracked file is modified) and its neighbour.
 */
async function gitRepositories() {
  const gitEnv = { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.test" };
  const git = (args, cwd) => bounded("git", args, { cwd, env: gitEnv });
  const make = async name => {
    const directory = join(root, name); await mkdir(directory);
    // A dev script: the seeding version resolves a Node.js launch command when the repository is registered.
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
    await writeFile(join(directory, "tracked.txt"), "one\n");
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "real repository fixture"]]) await git(args, directory);
    return realpath(directory);
  };
  const main = await make("linked-repo"), neighbour = await make("neighbour-repo");
  await git(["worktree", "add", "-q", "-b", "feature", join(root, "linked-feature")], main);
  const feature = await realpath(join(root, "linked-feature"));
  await writeFile(join(feature, "tracked.txt"), "changed\n");
  const head = (await git(["rev-parse", "HEAD"], main)).stdout.trim(), neighbourHead = (await git(["rev-parse", "HEAD"], neighbour)).stdout.trim();
  return { main, feature, neighbour, head, neighbourHead, linked: null, neighbourRegistration: null, projectId: null, neighbourProjectId: null };
}
/** The operator's accepted link decisions of every upgrade inspect in the released-baseline lane. */
const linkDecisions = () => [{ registrationId: repositories.linked, projectId: repositories.projectId }, { registrationId: repositories.neighbourRegistration, projectId: repositories.neighbourProjectId }];
async function decisionsArgs() {
  if (!repositories.projectId) return [];
  const file = join(root, "mapping-decisions.json");
  await writeFile(file, JSON.stringify({ links: linkDecisions() }), { mode: 0o600 });
  return ["--decisions", file];
}
/** The review accepts both links into the existing projects; the stored parents after apply are checked by {@link assertLinkedParents}. */
function assertLinkedReview(inspection) {
  for (const { registrationId, projectId } of linkDecisions()) {
    const row = inspection.review.mapping.registrations.find(entry => entry.id === registrationId);
    assert(row, `The mapping review lists registration ${registrationId}.`);
    assert.deepEqual(row.outcome, { projectId, basis: "accepted_link", created: false, existing: true });
    assert.equal(row.link.projectId, projectId); assert.equal(row.link.accepted, true);
  }
  assert.deepEqual(inspection.decisions.mapping.links, [...linkDecisions()].sort((a, b) => a.registrationId < b.registrationId ? -1 : 1));
}
function assertLinkedParents() {
  for (const { registrationId, projectId } of linkDecisions()) {
    assert.equal(observe(db => db.prepare("SELECT parent_project_id p FROM projects WHERE id=?").get(registrationId).p), projectId, "The accepted link is the registration's parent.");
  }
}
const fixturePaths = () => [repositories.main, repositories.feature, repositories.neighbour];
/** No fixture path, nor the repository directory names, appears anywhere in a denied or foreign answer. */
function assertWithoutPaths(value, paths, what) {
  const text = JSON.stringify(value);
  for (const path of paths) assert(!text.includes(path), `${what} must not contain ${path}`);
}
const tree = (path, branch, head, dirty) => ({ path, branch, head, shortHead: head.slice(0, 8), detached: false, locked: false, prunable: false, dirty });
/**
 * Project reads of one caller over the fixture's real repositories. `read(operation, input)` answers `{ status, body }`.
 * Permitted (installation authority, the local operator, the installation admin): the linked project releases exactly its
 * registration's two worktrees with path, branch, head and dirty state, and nothing of the neighbour; the neighbouring
 * project releases only its own. Denied (a caller without a project role): both existing projects answer exactly like a
 * missing one, and no answer contains a fixture path. In the fresh lane no registration has a parent (only the upgrade's
 * accepted links create parenthood), so only the parentless listing items of full authority carry the paths.
 */
async function repositoryReads(label, read, permitted) {
  repositoryEvidence.push({ label, permitted, lane: repositories.projectId ? "linked" : "parentless" });
  const listed = await read("project.list", { limit: 50 });
  assert.equal(listed.status, 200, `${label}: project.list`);
  if (!permitted) { assert.deepEqual(listed.body, { items: [], nextCursor: null }); assertWithoutPaths(listed.body, fixturePaths(), `${label} listing`); }
  if (!repositories.projectId) {
    if (!permitted) return;
    for (const [registrationId, path] of [[repositories.linked, repositories.main], [repositories.neighbourRegistration, repositories.neighbour]]) {
      const item = listed.body.items.find(entry => entry.projectId === null && entry.registrations[0]?.registrationId === registrationId);
      assert(item, `${label}: the parentless registration is its own item for full authority`);
      assert.equal(item.registrations.length, 1); assert.equal(item.registrations[0].worktreePath, path);
    }
    return;
  }
  const missing = { worktrees: await read("project.worktrees", { projectId: "missing-project" }), status: await read("project.status", { projectId: "missing-project" }) };
  for (const value of Object.values(missing)) { assert.equal(value.status, 404); assert.deepEqual(value.body, operationRefusal("resource_not_found", "not_found", 404, "none")); }
  const projects = [
    { projectId: repositories.projectId, registrationId: repositories.linked, own: [repositories.main, repositories.feature], foreign: [repositories.neighbour],
      worktrees: [tree(repositories.main, "main", repositories.head, false), tree(repositories.feature, "feature", repositories.head, true)] },
    { projectId: repositories.neighbourProjectId, registrationId: repositories.neighbourRegistration, own: [repositories.neighbour], foreign: [repositories.main, repositories.feature],
      worktrees: [tree(repositories.neighbour, "main", repositories.neighbourHead, false)] },
  ];
  for (const project of projects) {
    const worktrees = await read("project.worktrees", { projectId: project.projectId }), status = await read("project.status", { projectId: project.projectId });
    if (!permitted) {
      assert.deepEqual(worktrees, missing.worktrees, `${label}: an existing project's worktrees are refused like a missing project`);
      assert.deepEqual(status, missing.status, `${label}: an existing project's status is refused like a missing project`);
      assertWithoutPaths([worktrees, status], fixturePaths(), `${label} refusal`);
      continue;
    }
    assert.equal(worktrees.status, 200, `${label}: project.worktrees`);
    assert.deepEqual(worktrees.body, { projectId: project.projectId, registrationsTruncated: false,
      registrations: [{ registrationId: project.registrationId, discovery: "complete", worktreesTruncated: false, worktrees: project.worktrees }] });
    assert.equal(status.status, 200, `${label}: project.status`);
    assert.deepEqual(status.body.registrations.map(entry => [entry.registrationId, entry.selectedWorktreePath ?? entry.worktreePath]), [[project.registrationId, project.own[0]]]);
    const item = listed.body.items.find(entry => entry.projectId === project.projectId);
    assert.deepEqual(item.registrations.map(entry => [entry.registrationId, entry.worktreePath]), [[project.registrationId, project.own[0]]]);
    assertWithoutPaths([worktrees.body, status.body, item], project.foreign, `${label} ${project.projectId}`);
  }
}
/** HTTP project reads with a bearer credential (or none, in open mode). */
const bearerRead = secret => async (operation, input) => {
  const reply = await fetch(endpoint + `/api/operations/${operation}`, { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(input) });
  return { status: reply.status, body: await reply.json() };
};
/** MCP project reads through the installed SDK client: a tool error carries the same refusal body as HTTP. */
const toolRead = client => async (operation, input) => {
  const result = await client.callTool({ name: operation.replace(".", "_"), arguments: input });
  return result.isError ? { status: result.structuredContent.error.status, body: result.structuredContent } : { status: 200, body: result.structuredContent };
};
/** Project reads of the local operator through the installed CLI and the private socket. */
const cliRead = async (operation, input) => {
  const verb = operation.split(".")[1];
  const result = await command(currentCli, verb === "list" ? ["projects", "list", "--limit", String(input.limit)] : ["projects", verb, input.projectId]);
  if (result.code === 0) return { status: 200, body: JSON.parse(result.stdout) };
  const body = JSON.parse(result.stderr.trim().split("\n").at(-1)); return { status: body.error.status, body };
};
const cookieJar = () => {
  const cookies = new Map();
  return { cookies, async call(path, body, headers = {}, method = body === undefined ? "GET" : "POST") {
    // Node's HTTP client sends the canonical Host used by the real TLS proxy.
    // fetch may discard a caller-supplied Host and is unsuitable for this fixture.
    const response = await new Promise((accept, reject) => {
      const request = httpRequest(endpoint + path, { method, headers: { Host: "controller.test", Origin: origin, "Content-Type": "application/json",
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...headers } }, response => {
        const chunks = []; let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > 131_072) request.destroy(new Error("Fixture response bound")); else chunks.push(chunk); });
        response.once("error", reject); response.once("end", () => { try { accept({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { reject(new Error("Fixture JSON response")); } });
      });
      request.setTimeout(15_000, () => request.destroy(new Error("Fixture request deadline"))); request.once("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    for (const line of response.headers["set-cookie"] ?? []) {
      assert(/;\s*Secure/i.test(line) && /;\s*HttpOnly/i.test(line) && /SameSite=Strict/i.test(line));
      const pair = line.split(";")[0], index = pair.indexOf("=");
      if (/Max-Age=0/i.test(line)) cookies.delete(pair.slice(0, index)); else { cookies.set(pair.slice(0, index), pair.slice(index + 1)); secretValues.add(pair.slice(index + 1)); }
    }
    assert.equal(response.headers["cache-control"], "no-store");
    return { status: response.status, body: response.body };
  } };
};
/** A release directory from package-provider.mjs, or the local build's artifact.json. */
async function providerArtifact(argumentDirectory) {
  // Child npm commands run in the fixture root, so never pass a relative path on.
  const directory = argumentDirectory && resolve(argumentDirectory);
  if (!directory) return JSON.parse(await readFile(join(repository, "dist/private-auth-provider/artifact.json"), "utf8"));
  const provenance = JSON.parse(await readFile(join(directory, PROVIDER_RELEASE_FILES.provenance), "utf8"));
  assert.equal(provenance.kind, "optional-authentication-provider");
  const sums = (await readFile(join(directory, PROVIDER_RELEASE_FILES.checksums), "utf8")).trim().split("\n").map(line => line.split(/\s+/));
  for (const [hash, file] of sums) assert.equal(digest(await readFile(join(directory, file))), hash, `Provider release checksum mismatch: ${file}`);
  assert(sums.some(([hash, file]) => file === provenance.artifact.filename && hash === provenance.artifact.sha256));
  return { path: join(directory, provenance.artifact.filename), sha256: provenance.artifact.sha256, dependencyLockSha256: provenance.dependencyLock.sha256,
    providerId: provenance.provider.id, contract: provenance.provider.contract, implementationVersion: provenance.provider.implementationVersion, source: provenance.source, provenance };
}
let report;
try {
  await mkdir(data, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  const output = join(repository, "dist/rbac-artifacts"); await mkdir(output, { recursive: true, mode: 0o700 });
  const installEnv = await productionInstallEnvironment(root);
  // A supplied CI tarball is the exact release candidate; otherwise pack this checkout.
  const tarball = argument("--community") ? resolve(argument("--community"))
    : join(output, (await step("community-pack", async () => JSON.parse((await bounded("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], { cwd: repository })).stdout)[0])).filename);
  const communitySha256 = digest(await readFile(tarball));
  if (argument("--community-sha256")) assert.equal(communitySha256, argument("--community-sha256"), "Community tarball digest must match its provenance.");
  currentRoot = await step("clean-prefix-community-install", () => installProductionPrefix(tarball, join(root, "current"), root, installEnv, bounded));
  currentCli = join(currentRoot, "dist/cli/index.js"); native = await installedSqlite(currentRoot);
  assert(!currentRoot.startsWith(repository + "/"), "Installed package must not run from the source checkout.");
  // MCP clients come from the installed package, not the checkout.
  const sdk = join(currentRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm");
  const { Client } = await import(pathToFileURL(join(sdk, "client/index.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(sdk, "client/streamableHttp.js")));
  operationsSdk = { Client, StreamableHTTPClientTransport };
  const connect = async token => { const client = new Client({ name: "installed-rbac", version: "1" }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(mcpURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client; };
  const artifact = await providerArtifact(argument("--provider-dir"));
  assert.equal(digest(await readFile(artifact.path)), artifact.sha256);
  if (argument("--community") && argument("--provider-dir")) {
    const community = JSON.parse(await readFile(join(dirname(tarball), "provenance.json"), "utf8"));
    assert.equal(community.artifact.filename, tarball.slice(tarball.lastIndexOf("/") + 1));
    assert.equal(community.artifact.sha256, communitySha256);
    assert.equal(community.package.version, JSON.parse(await readFile(join(currentRoot, "package.json"), "utf8")).version);
    assertReleasePair(community, artifact.provenance);
  }
  // `npm install <tarball>` ignores a dependency's shrinkwrap and re-resolves; the
  // provider is extracted into its own directory and `npm ci` installs its lock.
  const providerRoot = join(root, "provider"), entry = join(providerRoot, "dist/index.js");
  await step("separate-optional-provider-install", async () => {
    await mkdir(providerRoot, { mode: 0o700 });
    await bounded("tar", ["-xzf", artifact.path, "-C", providerRoot, "--strip-components=1", "--no-same-owner"]);
    await bounded("npm", ["ci", "--prefix", providerRoot, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { env: installEnv });
  });
  const shippedLock = await readFile(join(providerRoot, "npm-shrinkwrap.json"));
  assert.equal(digest(shippedLock), artifact.dependencyLockSha256);
  await step("provider-installed-closure-matches-shipped-lock", async () => {
    const tree = JSON.parse((await bounded("npm", ["ls", "--prefix", providerRoot, "--all", "--omit=dev", "--json"], { env: installEnv })).stdout);
    // Unmet optional framework peers have no version and are not installed.
    const installed = new Set(), walk = node => { for (const [name, child] of Object.entries(node.dependencies ?? {})) { if (!child.version) continue; installed.add(`${name}@${child.version}`); walk(child); } };
    walk(tree);
    assert.deepEqual([...installed].sort(), [...shrinkwrapClosure(JSON.parse(shippedLock))].sort(), "Installed provider closure must equal the shipped lock.");
  });
  assert(!(await readFile(entry, "utf8")).includes("/test/"));
  let baselineArtifact = null;
  if (baseline === `public-${PUBLIC_BASELINE.version}`) {
    const directory = join(root, "baseline"); await mkdir(directory, { mode: 0o700 });
    const fetched = await step("public-baseline-fetch", async () => JSON.parse((await bounded("npm", ["pack", `${PUBLIC_BASELINE.name}@${PUBLIC_BASELINE.version}`, "--json", "--ignore-scripts", "--pack-destination", directory], { env: installEnv })).stdout)[0]);
    baselineArtifact = await verifyPublicBaseline(join(directory, fetched.filename));
    oldRoot = await step("public-baseline-install", () => installProductionPrefix(join(directory, fetched.filename), join(root, "old"), root, installEnv, bounded));
    oldCli = join(oldRoot, "dist/cli/index.js");
    assert.equal(JSON.parse(await readFile(join(oldRoot, "package.json"), "utf8")).version, PUBLIC_BASELINE.version);
  }
  const fresh = baseline === "fresh";
  // Fresh installs seed through the candidate itself; upgrades through the old release.
  const seedCli = fresh ? currentCli : oldCli, seedRoot = fresh ? currentRoot : oldRoot;
  const oldCliSha256 = digest(await readFile(seedCli));
  const oldOwner = await step(fresh ? "fresh-owner-and-history" : "old-release-owner-and-history", () => json(seedCli, ["identity", "bootstrap-owner"]));
  const ownerEnv = { WORKTREE_CONTROL_OWNER_TOKEN: oldOwner.token };
  const knowledge = (await json(seedCli, ["identity", "create-knowledge-project", "--name", "Preserved knowledge"], ownerEnv)).project;
  const oldAgent = (await json(seedCli, ["identity", "create-agent"], ownerEnv)).principal;
  await json(seedCli, ["identity", "grant-knowledge", "--principal-id", oldAgent.id, "--project-id", knowledge.id, "--permissions", "knowledge:read,knowledge:write"], ownerEnv);
  // The neighbouring project of the real-repository reads; the agent links its registration as released versions allowed.
  const neighbourKnowledge = (await json(seedCli, ["identity", "create-knowledge-project", "--name", "Neighbour knowledge"], ownerEnv)).project;
  await json(seedCli, ["identity", "grant-knowledge", "--principal-id", oldAgent.id, "--project-id", neighbourKnowledge.id, "--permissions", "knowledge:read,knowledge:write"], ownerEnv);
  const oldAgentCredential = await json(seedCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "old narrow client"], ownerEnv);
  const revokedBefore = await json(seedCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "revoked before upgrade"], ownerEnv);
  const revokedAfter = await json(seedCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "revoked after backup"], ownerEnv);
  await json(seedCli, ["identity", "revoke-token", "--credential-id", revokedBefore.credential.id], ownerEnv);
  const installation = await json(seedCli, ["auth", "token", "generate"]);
  await start(seedCli, seedRoot);
  const task = await json(seedCli, ["knowledge", "create_task", "--json", JSON.stringify({ projectId: knowledge.id, title: "Old history", description: "Preserved", idempotencyKey: "seed" })], { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: oldAgentCredential.token });
  repositories = await step(fresh ? "fresh-real-git-registrations" : "old-release-real-git-registrations-and-runtime-links", async () => {
    const value = await gitRepositories();
    const register = async (name, repositoryPath) => {
      const response = await fetch(endpoint + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
        body: JSON.stringify({ name, repositoryPath, port: await freePort(), launchPreset: "node" }) });
      assert.equal(response.status, 201, `The seeding version registers ${name}.`); return (await response.json()).project.id;
    };
    value.linked = await register("Linked registration", value.main); value.neighbourRegistration = await register("Neighbour registration", value.neighbour);
    // Only the upgrade's accepted links create parenthood; a fresh installation keeps both registrations parentless.
    if (fresh) return value;
    const agentEnv = { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: oldAgentCredential.token };
    for (const [projectId, runtimeProjectId] of [[knowledge.id, value.linked], [neighbourKnowledge.id, value.neighbourRegistration]]) {
      const read = await json(seedCli, ["knowledge", "project", "--json", JSON.stringify({ projectId })], agentEnv), revision = (read.value ?? read).revision;
      await json(seedCli, ["knowledge", "link_runtime", "--json", JSON.stringify({ projectId, runtimeProjectId, expectedRevision: revision, idempotencyKey: `link-${runtimeProjectId}` })], agentEnv);
    }
    assert.deepEqual(observe(db => db.prepare("SELECT knowledge_project_id p, runtime_project_id r FROM knowledge_project_runtime_links WHERE unlinked_at IS NULL ORDER BY knowledge_project_id").all()),
      [{ p: knowledge.id, r: value.linked }, { p: neighbourKnowledge.id, r: value.neighbourRegistration }].sort((a, b) => a.p < b.p ? -1 : 1));
    return { ...value, projectId: knowledge.id, neighbourProjectId: neighbourKnowledge.id };
  });
  await stop();
  const continuity = () => observe(db => ({ schema: db.prepare("SELECT max(version) n FROM schema_migrations").get().n,
    principal: db.prepare("SELECT id,kind,status FROM remote_principals WHERE id=?").get(oldOwner.principalId),
    grants: db.prepare("SELECT * FROM knowledge_project_grants ORDER BY principal_id,project_id").all(),
    credentials: db.prepare("SELECT * FROM principal_credentials ORDER BY id").all(),
    audit: db.prepare("SELECT * FROM controller_audit_events ORDER BY id").all() }));
  const before = continuity();
  let oldBackup;
  if (baseline === `public-${PUBLIC_BASELINE.version}`) {
    oldBackup = join(root, "home", "worktree-control-backups", "0.1.1-before-0.2.0");
    await mkdir(join(root, "home")); await chmod(join(root, "home"), 0o750);
    await step("public-0.1.1-application-backup-under-private-parent", async () => {
      const manifest = await json(oldCli, ["backup", "create", oldBackup]);
      assert.equal(manifest.database.schemaVersion, PUBLIC_BASELINE.schema);
    });
  }
  if (fresh) assert.equal(before.schema, CURRENT_SCHEMA); else assert(before.schema < CURRENT_SCHEMA);
  const marker = () => observe(db => db.prepare("SELECT state, plan_hash FROM upgrade_marker").get());
  const maintenanceBackups = join(root, "maintenance-backups");
  let planHash = null, resetEvidence = null;
  // Credentials used from here on. The fresh lane keeps the seeded ones (no upgrade happened). After an
  // upgrade only an explicitly recovered owner session and a newly issued agent credential authorize;
  // the pre-upgrade ones keep their own names and are only ever expected to be rejected.
  let currentOwnerEnv = ownerEnv, currentAgentCredential = oldAgentCredential;
  if (fresh) {
    await step("fresh-install-fence-current", async () => { const status = await json(currentCli, ["auth", "fence", "inspect"]); assert.equal(status.code, "security_fence_current"); assert.equal(status.establishmentAllowed, false); assert.equal(status.nextStep, "upgrade inspect"); });
    await step("fresh-install-schema-53-marker-complete-and-upgrade-current", async () => {
      assert.deepEqual(marker(), { state: "complete", plan_hash: null }, "A fresh installation starts with a complete marker and no plan hash.");
      const files = await sourceFiles();
      const inspection = await json(currentCli, ["upgrade", "inspect"]);
      assert.equal(inspection.state, "current"); assert.equal(inspection.nextStep, "none"); assert.equal(inspection.schemaVersion, CURRENT_SCHEMA);
      assert.equal(inspection.planHash, undefined); assert.equal(inspection.appliedPlan, null);
      assert.deepEqual(await sourceFiles(), files, "Inspecting a current database writes nothing, and no plan.");
    });
  } else {
    await step("pre-fence-ordinary-refusal-preserves-database", async () => {
      const files = await sourceFiles();
      for (const args of [["auth", "status"], ["start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(await freePort()), "--mcp-port", String(await freePort())]]) {
        await fenceRefusal(currentCli, args, "security_fence_establishment_required");
      }
      assert.deepEqual(await sourceFiles(), files, "Refused openings leave the 0.1.1 database and its WAL as they were.");
    });
    const preflight = await json(currentCli, ["auth", "fence", "inspect"]);
    assert.equal(preflight.establishmentAllowed, true); assert.equal(preflight.schemaVersion, before.schema); assert.equal(preflight.nextStep, "auth fence establish");
    await step("protected-fence-establish-with-backup", async () => {
      const established = await json(currentCli, ["auth", "fence", "establish", "--expect", preflight.preflight, "--backup-dir", maintenanceBackups]);
      assert.equal(established.trusted, true); assert.equal(established.changed, true); assert.equal(established.schemaVersion, CURRENT_SCHEMA);
      assert.equal(established.nextStep, "upgrade inspect", "An established fence points to the upgrade, not to an ordinary start.");
      assert.match(established.backup, new RegExp(`/pre-establishment-v${before.schema}-[0-9a-f-]{36}$`));
      assert.equal(JSON.parse(await readFile(join(established.backup, "manifest.json"), "utf8")).database.schemaVersion, before.schema);
      assert.deepEqual(marker(), { state: "pending", plan_hash: null }, "Establishment brings the structure to 53 with the marker pending.");
    });
    await step("upgrade-required-refusal-preserves-database", async () => {
      const files = await sourceFiles(), copies = (await readdir(maintenanceBackups)).sort(), port = await freePort();
      for (const args of [["start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(await freePort())], ["auth", "status"], ["identity", "list-agents"]]) {
        assert.deepEqual(await refusal(currentCli, args, ownerEnv), UPGRADE_REQUIRED, `${args[0]} must refuse with upgrade_required`);
      }
      assert.equal(await accepting(port), false, "A refused start opens no listener.");
      assert.deepEqual(await sourceFiles(), files, "A refused opening writes nothing.");
      assert.deepEqual((await readdir(maintenanceBackups)).sort(), copies, "A refused opening takes no backup.");
    });
    const inspection = await step("upgrade-inspect-reviews-the-reset", async () => {
      const value = await json(currentCli, ["upgrade", "inspect", ...await decisionsArgs()]);
      assert.equal(value.state, "upgrade_needed"); assert.equal(value.nextStep, "upgrade apply"); assert.equal(value.marker, "pending");
      assertLinkedReview(value);
      assert.equal(value.schemaVersion, CURRENT_SCHEMA); assert.equal(value.target, CURRENT_SCHEMA); assert.match(value.planHash, /^[0-9a-f]{64}$/);
      const authority = value.review.authority, active = kind => before.credentials.filter(row => row.kind === kind && row.status === "active").length;
      assert.deepEqual(authority.admin, { decision: "grant", accountId: oldOwner.principalId });
      for (const kind of ["agent_token", "owner_session"]) {
        const entry = authority.credentials.find(item => item.kind === kind);
        assert(active(kind) > 0); assert.equal(entry.active, active(kind)); assert.equal(entry.revokes, active(kind));
      }
      const grants = authority.grantTables.find(item => item.table === "knowledge_project_grants");
      assert.equal(grants.rows, before.grants.length); assert.equal(grants.revokes, before.grants.filter(row => row.revoked_at === null || row.revoked_at === undefined).length);
      assert(Array.isArray(value.acts) && value.acts.length > 0, "The review lists the operator's lines.");
      return value;
    });
    await step("upgrade-required-offline-session-describe", async () => {
      const result = await refusal(currentCli, ["session", "describe"]);
      assert.equal(result.code, "upgrade_required"); assert.equal(result.nextStep, "upgrade inspect");
      assert.equal(existsSync(join(state, "controller.lock")), false);
      assert.equal(existsSync(join(data, "state.sqlite3.owner.lock")), false);
    });
    await step("upgrade-apply-with-pre-upgrade-backup", async () => {
      const result = await json(currentCli, ["upgrade", "apply", "--expect", inspection.planHash, "--backup-dir", maintenanceBackups]);
      assert.equal(result.state, "current"); assert.equal(result.alreadyApplied, false); assert.equal(result.planHash, inspection.planHash);
      assert.equal(result.schemaVersion, CURRENT_SCHEMA); assert.equal(result.planRemoved, true);
      assert.match(result.backup, new RegExp(`/pre-upgrade-v${CURRENT_SCHEMA}-[0-9a-f-]{36}$`));
      assert.equal(JSON.parse(await readFile(join(result.backup, "manifest.json"), "utf8")).database.schemaVersion, CURRENT_SCHEMA);
      assert.deepEqual(marker(), { state: "complete", plan_hash: inspection.planHash });
      assertLinkedParents();
      planHash = inspection.planHash;
    });
  }
  await step(fresh ? "fresh-install-keeps-owner-grants-and-history" : "upgrade-resets-authority-and-keeps-owner-and-history", async () => {
    const after = continuity();
    // Later migrations may add columns; compare every value that existed before.
    const columns = rows => rows.length ? Object.keys(rows[0]) : [];
    const projected = (rows, names) => rows.map(row => Object.fromEntries(names.map(name => [name, row[name]])));
    assert.equal(after.schema, CURRENT_SCHEMA); assert.deepEqual(after.principal, before.principal);
    assert.deepEqual(projected(after.audit.slice(0, before.audit.length), columns(before.audit)), before.audit);
    assert.equal(observe(db => db.prepare("SELECT title FROM knowledge_tasks WHERE id=?").get(task.value.id).title), "Old history");
    if (fresh) {
      assert.deepEqual(projected(after.grants, columns(before.grants)), before.grants);
      assert(JSON.stringify(projected(after.credentials, columns(before.credentials))) === JSON.stringify(before.credentials), "Every credential field must be preserved.");
      return;
    }
    // Every grant and credential row is kept, and none authorizes any more.
    const key = row => `${row.principal_id}/${row.project_id}`;
    assert.deepEqual(after.grants.map(key), before.grants.map(key)); assert(after.grants.every(row => row.revoked_at !== null), "Every old grant is revoked.");
    assert.deepEqual(after.credentials.map(row => [row.id, row.kind]), before.credentials.map(row => [row.id, row.kind]));
    assert(after.credentials.every(row => row.status === "revoked"), "Every pre-upgrade credential is revoked.");
    const admin = observe(db => db.prepare("SELECT account_id, role, scope_kind, project_id FROM account_grants").all());
    assert.deepEqual(admin, [{ account_id: oldOwner.principalId, role: "admin", scope_kind: "installation", project_id: null }]);
    resetEvidence = { credentialsRevoked: after.credentials.length, grantsRevoked: after.grants.length, adminGrant: "owner" };
  });
  await step("community-token-mode-without-provider", async () => {
    // The installation token and the mode are kept by the upgrade.
    assert.equal((await json(currentCli, ["auth", "status"])).mode, "token");
    await operationOffline("token"); await start();
    storedOwner = oldOwner.token;
    await operationApi("token", installation.token); await operationSocket("token");
    const cookieRefused = await cookieJar().call("/api/operations/session.describe", {}, { Cookie: "__Secure-wtc.session_token=invalid" });
    assert.equal(cookieRefused.status, 401); assert.deepEqual(cookieRefused.body, operationRefusal("credential_not_accepted_here"));
    matrixCell("api-cookie", "token", null, "api", "credential_not_accepted_here", "community-token-mode-without-provider");
    const authorized = await fetch(endpoint + "/api/dashboard", { headers: { Authorization: `Bearer ${installation.token}` } }); await authorized.arrayBuffer();
    assert.equal(authorized.status, 200, "Installation token must keep working without a provider.");
    const anonymous = await fetch(endpoint + "/api/dashboard"); await anonymous.arrayBuffer(); assert.equal(anonymous.status, 401);
    const installationClient = await connect(installation.token);
    assert(!(await installationClient.callTool({ name: "list_projects", arguments: {} })).isError, "Installation token must keep working over MCP.");
    // Rejected over HTTP and MCP: a credential revoked before the upgrade, and after an upgrade every pre-upgrade one.
    const rejected = fresh ? [revokedBefore] : [revokedBefore, oldOwner, oldAgentCredential, revokedAfter];
    for (const { token } of rejected) for (const url of [endpoint + "/api/dashboard", mcpURL]) await credentialRejected(url, token);
    if (fresh) {
      const agent = await connect(oldAgentCredential.token);
      assert(!(await agent.callTool({ name: "knowledge_task", arguments: { projectId: knowledge.id, taskId: task.value.id } })).isError, "Without an upgrade the agent token keeps its Knowledge grant.");
    }
    await stop();
  });
  if (!fresh) {
    await step("explicit-owner-recovery-and-new-agent-denied-without-grant", async () => {
      const recovered = await json(currentCli, ["identity", "recover-owner"]);
      assert.equal(recovered.principalId, oldOwner.principalId); assert.notEqual(recovered.token, oldOwner.token);
      currentOwnerEnv = { WORKTREE_CONTROL_OWNER_TOKEN: recovered.token };
      const issued = await json(currentCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "after upgrade"], currentOwnerEnv);
      /**
       * The new credential's read of the old project's task over MCP: "read", or the code of the product's
       * tool-level refusal. The credential authenticates either way; a failed connection, a protocol error
       * or a rejected call is not a denial and fails the step.
       */
      const read = async () => {
        await start();
        try {
          const client = await connect(issued.token);
          const result = await client.callTool({ name: "knowledge_task", arguments: { projectId: knowledge.id, taskId: task.value.id } });
          return result.isError ? JSON.parse(result.content[0].text).code : "read";
        } finally { await stop(); }
      };
      // The token reset and the grant reset are separate: a new credential alone confers nothing.
      assert.equal(await read(), "knowledge_forbidden", "A new credential without a new grant must be refused by Knowledge authorization.");
      await json(currentCli, ["identity", "grant-knowledge", "--principal-id", oldAgent.id, "--project-id", knowledge.id, "--permissions", "knowledge:read,knowledge:write"], currentOwnerEnv);
      assert.equal(await read(), "read", "The explicitly granted new credential reads the old project.");
      currentAgentCredential = issued;
    });
  }
  await step("worker-installed-stored-credential-token-mode", async () => {
    const repo = join(root, "worker-registration"); await mkdir(repo);
    const gitEnv = { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.test" };
    for (const args of [["init", "-b", "main"], ["commit", "--allow-empty", "-m", "worker fixture"]]) await bounded("git", args, { cwd: repo, env: gitEnv });
    await start();
    const response = await fetch(endpoint + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
      body: JSON.stringify({ name: "Worker fixture", repositoryPath: repo, port: await freePort(), launchPreset: "none" }) });
    assert.equal(response.status, 201); const local = (await response.json()).project; await stop();
    const tokenFile = join(root, "worker-token"), provision = join(root, "worker-provision.json");
    await writeFile(provision, JSON.stringify({ project: { id: "worker-fixture", name: "Worker fixture", sourceRemote: "origin" }, worker: { id: "worker-fixture", name: "Worker fixture" },
      localProjectId: local.id, presetIds: ["node:test"], callerPrincipalIds: [oldAgent.id], workerTokenFile: tokenFile }));
    await json(currentCli, ["remote-verification", "provision", "--file", provision], currentOwnerEnv);
    storedWorker = (await readFile(tokenFile, "utf8")).trim(); secretValues.add(storedWorker);
    await start(); await operationWorker("token", installation.token); await stop();
  });
  await step("community-open-mode-without-provider", async () => {
    await json(currentCli, ["auth", "mode", "set", "open"]); await operationOffline("open"); await start();
    await operationApi("open"); await operationSocket("open");
    const cookieRefused = await cookieJar().call("/api/operations/session.describe", {}, { Cookie: "__Secure-wtc.session_token=invalid" });
    assert.equal(cookieRefused.status, 401); assert.deepEqual(cookieRefused.body, operationRefusal("credential_in_open_mode"));
    matrixCell("api-cookie", "open", null, "api", "credential_in_open_mode", "community-open-mode-without-provider");
    const anonymous = await fetch(endpoint + "/api/dashboard"); await anonymous.arrayBuffer(); assert.equal(anonymous.status, 200);
    await stop(); await json(currentCli, ["auth", "mode", "set", "token"]);
  });
  await step("real-provider-configure-enroll-existing-owner", async () => {
    await json(currentCli, ["auth", "provider", "configure", "--input-stdin"], {}, { module: entry, origin, signingSecret: { kind: "generate" } });
    await json(currentCli, ["auth", "provider", "enroll", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { email: "owner@fixture.invalid", name: "Existing owner", password });
  });
  if (fresh) await json(currentCli, ["identity", "revoke-token", "--credential-id", revokedAfter.credential.id], currentOwnerEnv);
  else assert.equal(observe(db => db.prepare("SELECT status FROM principal_credentials WHERE id=?").get(revokedAfter.credential.id).status), "revoked", "The upgrade already revoked it.");
  const repo = join(root, "project"); await mkdir(repo);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
  await writeFile(join(repo, "test.mjs"), "console.log('finite test failure evidence');process.exitCode=2;\n");
  const gitEnv = { ...env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.test" };
  for (const args of [["init", "-b", "main"], ["add", "."], ["commit", "-m", "finite fixture"]]) await bounded("git", args, { cwd: repo, env: gitEnv });
  await start();
  const postUpgradeTask = await json(currentCli, ["knowledge", "create_task", "--json", JSON.stringify({ projectId: knowledge.id, title: "After upgrade", description: "Not in the old backup", idempotencyKey: "post-upgrade" })], { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: currentAgentCredential.token });
  const added = await fetch(endpoint + "/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${installation.token}` },
    body: JSON.stringify({ name: "Finite verification", repositoryPath: repo, port: await freePort(), launchPreset: "none" }) });
  assert.equal(added.status, 201); const project = (await added.json()).project;
  await stop();
  const actions = ["projects:read", "tests:run", "profiles:select", "config:write", "logs:read", "storage:read", "capacity:read"];
  await json(currentCli, ["identity", "set-runtime-delegation", "--principal-id", oldAgent.id, "--project-id", project.id, "--actions", actions.join(","), "--expected-revision", "0"], currentOwnerEnv);
  const credential = await json(currentCli, ["identity", "issue-runtime-credential", "--principal-id", oldAgent.id, "--label", "explicit diagnostics", "--projects-json", JSON.stringify([{ projectId: project.id, actions }])], currentOwnerEnv);
  await json(currentCli, ["auth", "provider", "runtime-access", "set", "--input-stdin"], {}, { principalId: oldOwner.principalId,
    scope: { kind: "runtime-project", id: project.id }, role: "operator", permissions: ["projects:read", "tests:run", "profiles:select", "config:write"], expectedRevision: 0 });
  await step("protected-rbac-selection-and-real-restart", async () => {
    await json(currentCli, ["auth", "mode", "set", "better-auth"]); await operationOffline("better-auth"); await start();
    assert.equal((await json(currentCli, ["auth", "status"])).activeMode, "better-auth");
  });
  const browser = cookieJar();
  await step("public-packaged-login-and-transport-denial-matrix", async () => {
    assert.deepEqual((await browser.call("/api/auth/status")).body, { mode: "better-auth", loginAvailable: true });
    const login = await browser.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password }); assert.equal(login.status, 200);
    assert(!JSON.stringify(login.body).match(/token|password|hash/i));
    const description = await browser.call("/api/operations/session.describe", {});
    assert.equal(description.status, 200); assert.deepEqual(description.body.actor, { kind: "human", accountId: oldOwner.principalId });
    assert.equal(description.body.mode, "better-auth"); assert.equal(description.body.listener, "api");
    const invalidCookie = await browser.call("/api/operations/session.describe", {}, { Cookie: "__Secure-wtc.session_token=invalid" });
    assert.equal(invalidCookie.status, 401); assert.equal(invalidCookie.body.error.reason, "invalid_credential");
    const wrongOrigin = await browser.call("/api/operations/session.describe", {}, { Origin: "https://wrong.invalid" });
    assert.equal(wrongOrigin.status, 403); assert.deepEqual(wrongOrigin.body, operationRefusal("origin_forbidden", "forbidden", 403, "none"));
    matrixCell("api-cookie", "better-auth", "human", "api", "invalid_credential", "public-packaged-login-and-transport-denial-matrix");
    assert.equal((await browser.call("/api/operations/session.describe", {}, { Authorization: `Bearer ${installation.token}` })).body.error.reason, "mixed_credentials");
    await operationApi("better-auth", currentAgentCredential.token); await operationSocket("better-auth");
    await projectReadsAsHuman(browser, oldOwner.principalId, currentAgentCredential.token);
    const session = await browser.call("/api/auth/get-session"); assert.equal(session.body.principal.id, oldOwner.principalId);
    assert.equal((await browser.call("/api/runtime/read", { operation: "list-projects" })).status, 200);
    for (const path of ["/api/dashboard", "/api/events", "/api/backups", "/api/identity/bootstrap", "/api/dev-vault", "/api/auth/sign-up/email", "/api/auth/revoke-sessions"]) assert.equal((await browser.call(path, {})).status, 401);
    assert.equal((await browser.call("/api/auth/get-session", undefined, { Authorization: `Bearer ${installation.token}`, "X-Worktree-Switcher-Token": installation.token })).status, 401);
  });
  const client = await connect(credential.token);
  // The knowledge-only agent credential in use (the seeded one in the fresh lane, the new one after an upgrade).
  await step("knowledge-credential-ceiling-does-not-gain-new-delegation", async () => {
    const old = await connect(currentAgentCredential.token);
    const projects = await old.callTool({ name: "list_projects", arguments: {} }); assert(!projects.isError); assert.deepEqual(JSON.parse(projects.content[0].text), []);
    const names = (await old.listTools()).tools.map(tool => tool.name);
    for (const name of ["get_runtime_logs", "get_project_storage", "get_server_capacity", "get_test_queue"]) assert(!names.includes(name));
    await old.close(); clients.splice(clients.indexOf(old), 1);
  });
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert(!result.isError, `MCP ${name} denied`); return JSON.parse(result.content[0].text); };
  await step("real-mcp-runtime-verification-config-and-diagnostics", async () => {
    assert.equal((await call("list_projects"))[0].id, project.id);
    await call("get_project_status_compact", { projectId: project.id }); await call("list_worktrees", { projectId: project.id });
    await call("get_project_configuration", { projectId: project.id, worktreePath: repo });
    await call("get_runtime_logs", { projectId: project.id }); await call("get_project_storage", { projectId: project.id });
    assert(!JSON.stringify(await call("get_server_capacity")).includes("holders")); await call("get_test_queue");
    const presets = await call("list_test_presets", { projectId: project.id }); assert(presets[0].presets.some(preset => preset.id === "node:test"));
    const run = await call("run_test", { projectId: project.id, worktreePath: repo, presetId: "node:test", idempotencyKey: randomUUID() });
    const runId = run.status?.runId ?? run.runId; assert.equal(typeof runId, "string");
    const terminal = await wait(async () => { const result = await call("get_test_run", { runId }); return ["failed", "passed"].includes(result.status?.phase ?? result.phase) ? result : null; });
    assert.equal(terminal.status?.phase ?? terminal.phase, "failed");
    assert(JSON.stringify(await call("get_test_run_logs", { runId })).includes("finite test failure evidence"));
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
      AGENT_MCP_SECRETS_FILE: secrets, WORKTREE_SWITCHER_MCP_HEADER_FILE: headers, BROWSER: "false",
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
    await json(currentCli, ["identity", "revoke-token", "--credential-id", credential.credential.id], currentOwnerEnv);
    await assert.rejects(client.callTool({ name: "get_test_queue", arguments: {} }));
    const response = await fetch(mcpURL, { method: "POST", headers: { Authorization: `Bearer ${installation.token}`, "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 401);
  });
  await step("logout-and-ordinary-restart", async () => {
    const old = browser.cookies.get("__Secure-wtc.session_token"); await browser.call("/api/auth/sign-out", {});
    const signedOut = await browser.call("/api/operations/session.describe", {}, { Cookie: `__Secure-wtc.session_token=${old}` });
    assert.equal(signedOut.status, 401); assert.deepEqual(signedOut.body, operationRefusal("invalid_credential"));
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
    assert.equal((await one.call("/api/auth/two-factor/verify-totp", { code: used })).status, 401, "Enrollment-code replay must be rejected.");
    // Better Auth also limits this native endpoint to three requests per 10 seconds.
    // A nearby TOTP step boundary alone may leave that independent window full.
    const nativeWindowEnds = Date.now() + 11_000;
    await wait(() => Math.floor(Date.now()/30_000) > enrolledStep && Date.now() >= nativeWindowEnds, 35_000);
    const next = code(); assert.equal((await one.call("/api/auth/two-factor/verify-totp", { code: next })).status, 200, "A fresh TOTP step must authenticate.");
    const two = cookieJar(); await two.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password });
    assert.equal((await two.call("/api/auth/two-factor/verify-totp", { code: next })).status, 401, "Independent-challenge replay must be rejected.");
    const freshWindow = Date.now() + 61_000; await wait(() => Date.now() >= freshWindow, 65_000);
    const invalid = cookieJar(); await invalid.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password });
    const accepted = new Set([-1,0,1].map(code)); let wrong = 0; while (accepted.has(String(wrong).padStart(6,"0"))) wrong++;
    const charged = () => observe(db => db.prepare("SELECT coalesce(sum(charged),0) n FROM authentication_factor_budgets WHERE scope='totp' AND epoch=?").get(Math.floor(Date.now()/60_000)).n);
    const before = charged(); assert.equal((await invalid.call("/api/auth/two-factor/verify-totp", { code: String(wrong).padStart(6,"0") })).status, 401, "A fresh-window invalid guess must fail authentication.");
    assert.equal(charged(), before+1);
    for (let i=0;i<5;i++) assert([401,429].includes((await invalid.call("/api/auth/two-factor/verify-totp", { code: String(wrong).padStart(6,"0") })).status));
    assert.equal((await invalid.call("/api/auth/two-factor/verify-totp", { code: code() })).status, 429);
    await stop();
  });
  await step("raw-database-rollback-fence-and-protected-recovery", async () => {
    const backup = join(root, "rollback.sqlite3"); const db = new native.Database(join(data, "state.sqlite3"), { readonly: true }); try { await db.backup(backup); } finally { db.close(); }
    await json(currentCli, ["auth", "provider", "recover", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { newPassword: replacement });
    await cp(backup, join(data, "state.sqlite3")); await rm(join(data, "state.sqlite3-wal"), { force: true }); await rm(join(data, "state.sqlite3-shm"), { force: true });
    await fenceRefusal(currentCli, ["auth", "status"], "security_fence_recovery_required");
    const inspected = await json(currentCli, ["auth", "fence", "inspect"]);
    await json(currentCli, ["auth", "fence", "resume", "--expect", inspected.preflight, "--mode", "better-auth"]);
    // The resumed database needs the upgrade again before any credential recovery.
    assert.deepEqual(await refusal(currentCli, ["auth", "status"]), UPGRADE_REQUIRED);
    // The quarantine cleared every parent; the operator accepts the same links again (link rows are never changed).
    const upgrade = await json(currentCli, ["upgrade", "inspect", ...await decisionsArgs()]); assert.equal(upgrade.state, "upgrade_needed"); assert.equal(upgrade.marker, "pending");
    if (repositories.projectId) assertLinkedReview(upgrade);
    await json(currentCli, ["upgrade", "apply", "--expect", upgrade.planHash, "--backup-dir", maintenanceBackups]);
    if (repositories.projectId) assertLinkedParents();
    observe(db => {
      assert.equal(db.prepare("SELECT count(*) n FROM principal_credentials WHERE status='active'").get().n, 0);
      for (const table of ["knowledge_project_grants", "runtime_delegations", "runtime_human_memberships"]) assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE revoked_at IS NULL`).get().n, 0);
    });
    await json(currentCli, ["auth", "provider", "recover", "--principal-id", oldOwner.principalId, "--input-stdin"], {}, { newPassword: replacement });
    await start(); const recovered = cookieJar();
    assert.equal((await recovered.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password })).status, 401);
    const login = await recovered.call("/api/auth/sign-in/email", { email: "owner@fixture.invalid", password: replacement }); assert.equal(login.status, 200);
    assert.equal((await recovered.call("/api/auth/get-session")).body.principal.id, oldOwner.principalId);
    const empty = await recovered.call("/api/runtime/read", { operation: "list-projects" }); assert.equal(empty.status, 200); assert.deepEqual(empty.body.projects, []);
    if (repositories.projectId) {
      // The repeated upgrade grants the installation admin again; the recovered session reads the re-attached repositories.
      assert.equal(observe(db => db.prepare("SELECT count(*) n FROM account_grants WHERE account_id=? AND role='admin' AND scope_kind='installation'").get(oldOwner.principalId).n), 1);
      await repositoryReads("api-cookie/better-auth/admin-after-rollback-recovery", (operation, input) => recovered.call(`/api/operations/${operation}`, input), true);
    }
    for (const agent of new Set([oldAgentCredential, currentAgentCredential])) await knowledgeCredentialRejected(agent.token, knowledge.id);
    await stop();
    const principals = observe(db => db.prepare("SELECT id,kind,status FROM remote_principals WHERE kind='owner'").all()); assert.deepEqual(principals, [before.principal]);
    assert.equal(observe(db => db.prepare("SELECT title FROM knowledge_tasks WHERE id=?").get(task.value.id).title), "Old history");
  });
  if (oldBackup) {
    const restoreAndResume = async label => {
      await step(`${label}-public-backup-restore-requires-resume`, async () => {
        assert.equal((await command(currentCli, ["backup", "restore", oldBackup])).code, 0, "The candidate must restore the public 0.1.1 application backup.");
        await fenceRefusal(currentCli, ["auth", "status"], "security_fence_recovery_required");
        const preflight = await json(currentCli, ["auth", "fence", "inspect"]);
        assert.equal(preflight.schemaVersion, PUBLIC_BASELINE.schema);
        assert.equal(preflight.code, "security_fence_recovery_required"); assert.equal(preflight.establishmentAllowed, false);
        // Refused because the restore is fenced, not for a missing argument: --backup-dir is given, and no copy is taken.
        const refused = join(root, `${label}-refused-establishment`);
        const establish = await command(currentCli, ["auth", "fence", "establish", "--expect", preflight.preflight, "--backup-dir", refused]);
        assert.equal(establish.code, 1); assert.equal(JSON.parse(establish.stderr.trim().split("\n").at(-1)).code, "security_fence_recovery_required");
        assert.deepEqual(await readdir(refused).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []);
        const unchanged = await json(currentCli, ["auth", "fence", "inspect"]); assert.equal(unchanged.preflight, preflight.preflight);
        const resumed = await json(currentCli, ["auth", "fence", "resume", "--expect", unchanged.preflight, "--mode", "token"]);
        assert.equal(resumed.nextStep, "upgrade inspect");
        // After a restore: resume, inspect and apply, then credentials.
        assert.deepEqual(await refusal(currentCli, ["auth", "status"]), UPGRADE_REQUIRED);
        // The 0.1.1 backup holds both registrations and their current links; the operator accepts the links again.
        const upgrade = await json(currentCli, ["upgrade", "inspect", ...await decisionsArgs()]); assert.equal(upgrade.state, "upgrade_needed"); assert.equal(upgrade.marker, "pending");
        assert.equal(upgrade.schemaVersion, CURRENT_SCHEMA); assertLinkedReview(upgrade);
        const applied = await json(currentCli, ["upgrade", "apply", "--expect", upgrade.planHash, "--backup-dir", join(root, `${label}-maintenance-backups`)]);
        assert.equal(applied.state, "current"); assert.deepEqual(marker(), { state: "complete", plan_hash: upgrade.planHash });
        assertLinkedParents();
      });
      await step(`${label}-restored-data-preserved-and-authority-quarantined`, async () => {
        const after = continuity(); assert.equal(after.schema, CURRENT_SCHEMA); assert.deepEqual(after.principal, before.principal);
        assert(after.credentials.every(value => value.status === "revoked"));
        assert(after.grants.every(value => value.revoked_at !== null));
        observe(db => {
          assert.equal(db.prepare("SELECT title FROM knowledge_tasks WHERE id=?").get(task.value.id).title, "Old history");
          assert.equal(db.prepare("SELECT id FROM knowledge_tasks WHERE id=?").get(postUpgradeTask.value.id), undefined, "Snapshot restore loses later writes, as documented.");
        });
        const freshToken = await json(currentCli, ["auth", "token", "generate"]);
        const renewedEnv = { WORKTREE_CONTROL_TOKEN: freshToken.token };
        await json(currentCli, ["identity", "grant-knowledge", "--principal-id", oldAgent.id, "--project-id", knowledge.id, "--permissions", "knowledge:read,knowledge:write"], renewedEnv);
        const renewedAgent = await json(currentCli, ["identity", "issue-agent-token", "--principal-id", oldAgent.id, "--label", "after protected restore"], renewedEnv);
        await start();
        for (const token of new Set([installation.token, oldOwner.token, oldAgentCredential.token, revokedBefore.token, revokedAfter.token, credential.token,
          currentOwnerEnv.WORKTREE_CONTROL_OWNER_TOKEN, currentAgentCredential.token])) {
          for (const url of [endpoint + "/api/dashboard", mcpURL]) {
            const denied = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            await denied.arrayBuffer(); assert.equal(denied.status, 401, "Restoring old data must never revive any prior authority.");
          }
        }
        const authorized = await fetch(endpoint + "/api/dashboard", { headers: { Authorization: `Bearer ${freshToken.token}` } });
        await authorized.arrayBuffer(); assert.equal(authorized.status, 200);
        const renewed = await connect(renewedAgent.token);
        const restoredTask = await renewed.callTool({ name: "knowledge_task", arguments: { projectId: knowledge.id, taskId: task.value.id } });
        assert(!restoredTask.isError, "An explicitly regranted new credential must read the restored task.");
        // The restored registrations read their real worktrees under the new installation token, over HTTP and MCP.
        await repositoryReads(`${label}-restore/api-bearer/token`, bearerRead(freshToken.token), true);
        const operations = new operationsSdk.Client({ name: "restored-operations", version: "1" }); clients.push(operations);
        await operations.connect(new operationsSdk.StreamableHTTPClientTransport(new URL(mcpURL + "/operations"), { requestInit: { headers: { Authorization: `Bearer ${freshToken.token}` } } }));
        await repositoryReads(`${label}-restore/mcp/token`, toolRead(operations), true);
        await stop();
      });
    };
    await restoreAndResume("existing-installation");
    const originalArgs = directoryArgs;
    directoryArgs = ["--data-dir", join(root, "empty-data"), "--state-dir", join(root, "empty-state")];
    await mkdir(directoryArgs[1], { mode: 0o700 }); await mkdir(directoryArgs[3], { mode: 0o700 });
    try { await restoreAndResume("empty-installation"); } finally { directoryArgs = originalArgs; }
  }
  // Reset evidence replaces the former "grants preserved" claim: an upgrade revokes every old grant and credential.
  const authority = fresh ? { upgrade: "none: fresh installation at schema 53 with a complete marker", seededGrantsAndTokensKeepWorking: true }
    : { upgrade: { planHash, ...resetEvidence }, preUpgradeCredentialsRejected: true, newCredentialDeniedWithoutGrant: true, explicitGrantRestoresAccess: true, installationTokenKept: true };
  const snapshot = { baseline, oldSchema: before.schema, currentSchema: CURRENT_SCHEMA, communityWithoutProvider: ["token", "open"], ownerContinuity: true, authority,
    oldCredentialsNotWidened: true, restorationQuarantinesAuthority: true, publicBackupRestore: oldBackup ? ["existing-installation", "empty-installation"] : [],
    realRepositories: { lane: repositories.projectId ? "linked registrations by accepted upgrade links" : "parentless registrations (no parent writer outside the upgrade)",
      worktrees: { linked: 2, neighbour: 1 }, reads: repositoryEvidence,
      scopedReader: "not provisionable in an installed package: no supported interface writes a project-scoped account grant; covered by src/server/modules/operations/project-reads-transports.test.ts" },
    durationMs: steps.reduce((sum, entry) => sum + (entry.ms ?? 0), 0) };
  assert.deepEqual([...new Set(operationsMatrix.map(cell => `${cell.surface}/${cell.mode}`))].sort(), [...EXPECTED_OPERATIONS_MATRIX_KEYS].sort());
  report = { result: "passed", steps, source: (await bounded("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
    community: { path: tarball, sha256: communitySha256 }, provider: artifact,
    baseline: { kind: baseline, artifact: baselineArtifact, cliSha256: oldCliSha256 }, evidence: snapshot };
} catch (error) {
  report = failureReport(baseline, steps, error);
  process.exitCode = 1;
} finally {
  let forced = false, graceful = true;
  try { await stop(); } catch { graceful = false; }
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) { forced = true; child.kill("SIGKILL"); }
    try { await wait(() => child.exitCode !== null || child.signalCode !== null, 5_000); children.delete(child); }
    catch { graceful = false; }
  }
  cleanupConfirmed = children.size === 0;
  if (!graceful || forced || !cleanupConfirmed) { report.result = "failed"; report.cleanupFailure = true; process.exitCode = 1; }
  // Keep private fixture state if ownership could not be confirmed as ended.
  if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
  report.operationsMatrix = operationsMatrix;
  report.cleanupConfirmed = cleanupConfirmed;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
