#!/usr/bin/env node
import { parseKnowledgeCommandArgs, runKnowledgeCommand } from "./knowledge-management";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../package.json";
import type { ControllerDashboardResponse } from "../shared/contracts";
import { systemLocale, translate } from "../i18n/messages";
import { localizeServerMessage } from "../i18n/server-errors";
import { openBrowser } from "./browser";
import {
  directControllerOrigin,
  interactiveControllerOrigin,
  parsePublicControllerOrigin,
  validatePublicControllerBackend,
} from "./controller-addresses";
import { writeCliLine } from "./output";
import { runAuthCommand } from "./auth-management";
import { runIdentityCommand } from "./identity-management";
import { runBackupCommand } from "./backup-management";
import { pairingUrl } from "./pairing-url";
import { openProjectGateway, runDoctorCommand, runProjectCommand } from "./project-management";
import { controllerAccessToken, localDashboardEndpoint, publicDashboardEndpoint, readServiceAccess, removeServiceAccess, writeServiceAccess } from "./service-access";
import { mcpConfigToken } from "./mcp-config";
import { buildServiceStartArguments } from "./service-install";
import { UserServiceManager } from "./service-manager";
import { ControlService } from "../server/control-service";
import { acquireControllerLock } from "../server/controller-lock";
import { DirectoryBrowser } from "../server/directory-browser";
import { EventStream } from "../server/events";
import { FileLogWriter } from "../server/log-writer";
import { ProjectLifecycle } from "../server/modules/lifecycle";
import { AuthenticationService } from "../server/modules/authentication";
import { IdentityService } from "../server/modules/identity";
import { KnowledgeAttachmentService, KnowledgeService } from "../server/modules/knowledge";
import { createMcpControllerServer } from "../server/mcp-http-server";
import { SystemGitWorktreeReader } from "../server/git-worktrees";
import { createControllerServer } from "../server/http-server";
import { resolveAppPaths } from "../server/paths";
import { ProcessManager } from "../server/process-manager";
import { loadOrCreateSecret } from "../server/secret-file";
import { SqliteStateStore } from "../server/sqlite-store";
import { WorktreeStorageManager } from "../server/worktree-storage";
import { TestJobManager } from "../server/test-job-manager";

function option(name: string, args = process.argv): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function optionalPositiveNumber(value: string | undefined, label: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number.`);
  return parsed;
}

async function main(): Promise<void> {
  const locale = systemLocale(process.env);
  const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "start";
  const knowledgeArgs = command === "knowledge" ? parseKnowledgeCommandArgs(process.argv.slice(3)) : undefined;
  const paths = knowledgeArgs
    ? resolveAppPaths(knowledgeArgs.dataDir, knowledgeArgs.stateDir)
    : resolveAppPaths(option("--data-dir"), option("--state-dir"));
  if (command === "service") {
    await handleServiceCommand(process.argv.slice(3), paths);
    return;
  }
  if (command === "config" && process.argv[3] === "path") {
    writeCliLine(paths.databasePath);
    return;
  }
  if (command === "knowledge") {
    await runKnowledgeCommand(knowledgeArgs!.args, paths, { write: writeCliLine });
    return;
  }
  if (command === "auth") {
    await runAuthCommand(process.argv.slice(3), paths, { write: writeCliLine });
    return;
  }
  if (command === "identity") {
    await runIdentityCommand(process.argv.slice(3), paths, { write: writeCliLine });
    return;
  }
  if (command === "backup") {
    await runBackupCommand(process.argv.slice(3), paths, packageJson.version, writeCliLine);
    return;
  }
  if (command === "project" || command === "doctor") {
    const gateway = await openProjectGateway(paths, locale);
    try {
      if (command === "project") {
        await runProjectCommand(process.argv.slice(3), gateway, locale, { write: writeCliLine });
      } else if (!await runDoctorCommand(gateway, locale, writeCliLine)) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(localizeServerMessage(message, locale));
    } finally {
      await gateway.close();
    }
    return;
  }
  const mcpPort = Number(option("--mcp-port") ?? 47832);
  if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535) {
    throw new Error(translate(locale, "cli.invalidMcpPort"));
  }
  if (command === "config" && process.argv[3] === "mcp") {
    writeCliLine(JSON.stringify({
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      headers: { Authorization: `Bearer ${mcpConfigToken(paths)}` },
    }, null, 2));
    return;
  }
  if (command !== "start") {
    console.error(translate(locale, "cli.commands"));
    process.exitCode = 1;
    return;
  }

  const host = option("--host") ?? "0.0.0.0";
  const port = Number(option("--port") ?? 47831);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(translate(locale, "cli.invalidPort"));
  const configuredPublicOrigin = option("--public-url");
  const publicOrigin = configuredPublicOrigin ? parsePublicControllerOrigin(configuredPublicOrigin) : undefined;
  validatePublicControllerBackend(host, publicOrigin);
  const defaultWebRoot = resolve(fileURLToPath(new URL("../../out", import.meta.url)));
  const webRoot = resolve(option("--web-root") ?? defaultWebRoot);
  if (!existsSync(webRoot)) throw new Error(translate(locale, "cli.missingPanel", { path: webRoot }));

  const controllerLock = acquireControllerLock(paths.controllerLockPath);

  const events = new EventStream();
  const logs = new FileLogWriter(paths.logDirectory);
  const store = new SqliteStateStore(paths.databasePath);
  const authentication = new AuthenticationService(store);
  try {
    authentication.assertStartupPolicy();
  } catch (error) {
    store.close();
    controllerLock.release();
    throw error;
  }
  const memoryWarningMiB = optionalPositiveNumber(option("--memory-warning-mib"), "Memory warning threshold");
  const processes = new ProcessManager((projectId) => events.publish({ kinds: ["runtime"], projectIds: [projectId] }), logs, {
    memoryWarningThresholdBytes: memoryWarningMiB === null ? null : Math.round(memoryWarningMiB * 1024 * 1024),
  });
  const lifecycle = new ProjectLifecycle(store, processes);
  const storage = new WorktreeStorageManager(store, lifecycle, undefined, (projectId) => events.publish({ kinds: ["storage"], projectIds: [projectId] }));
  const tests = new TestJobManager(store, logs, (projectId) => events.publish({
    kinds: ["tests", "controller"],
    ...(projectId ? { projectIds: [projectId] } : {}),
  }));
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication);
  const attachments = new KnowledgeAttachmentService(store, identity, paths.knowledgeAttachmentDirectory);
  const knowledge = new KnowledgeService(store, identity, undefined, undefined, events.publishKnowledge, attachments);
  const service = new ControlService(store, new SystemGitWorktreeReader(), processes, logs, undefined, storage, undefined, undefined, tests, lifecycle, knowledge);
  const accessToken = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(8).toString("hex");
  const mcpSessions = new Set<string>();
  const mcpEndpoint = `http://127.0.0.1:${mcpPort}/mcp`;
  const mcp = process.argv.includes("--no-mcp") ? null : createMcpControllerServer({
    service,
    port: mcpPort,
    accessToken: loadOrCreateSecret(paths.mcpTokenPath),
    identity,
    authentication,
    onDiagnostic: (message, details) => {
      const mcpSessionId = typeof details?.sessionId === "string" ? details.sessionId : null;
      if (message === "mcp.session_started" && mcpSessionId) {
        mcpSessions.add(mcpSessionId);
        events.publish({ kinds: ["controller"] });
      } else if (message === "mcp.session_closed" && mcpSessionId) {
        mcpSessions.delete(mcpSessionId);
        events.publish({ kinds: ["controller"] });
      }
      logs.controller(message, details);
    },
  });
  const controller = createControllerServer({
    service,
    directoryBrowser: new DirectoryBrowser(option("--browse-root") ?? homedir()),
    events,
    mcpStatus: () => ({
      phase: !mcp ? "disabled" : mcp.server.listening ? "running" : "stopped",
      endpoint: mcp ? mcpEndpoint : null,
      transport: "streamable-http",
      network: "loopback",
      authentication: "bearer",
      activeSessions: mcpSessions.size,
    }),
    webRoot,
    host,
    port,
    accessToken,
    identity,
    authentication,
    publicOrigin,
  });
  try {
    await listen(controller.server, port, host);
    if (mcp) await listen(mcp.server, mcpPort, "127.0.0.1");
  } catch (error) {
    await mcp?.close();
    await controller.close();
    await service.shutdown();
    controllerLock.release();
    throw error;
  }
  const wildcardHost = host === "0.0.0.0" || host === "::";
  const browserHost = wildcardHost ? "127.0.0.1" : host;
  const lanHost = wildcardHost ? findLanAddress() ?? browserHost : host;
  const localOrigin = directControllerOrigin(browserHost, port);
  const advertisedOrigin = publicOrigin ?? directControllerOrigin(lanHost, port);
  // Outside legacy mode the pairing token grants nothing, so links open the sign-in screen instead.
  const authenticationMode = authentication.mode();
  const accessLink = (origin: string) => authenticationMode === "legacy"
    ? pairingUrl(origin, accessToken, sessionId)
    : new URL("/", origin).toString();
  const advertisedAddress = accessLink(advertisedOrigin);
  const interactiveAddress = accessLink(interactiveControllerOrigin(localOrigin, publicOrigin));
  const serviceMode = process.argv.includes("--service-mode");
  writeCliLine(translate(locale, "cli.listening", { host, port }));
  if (serviceMode) {
    writeServiceAccess(paths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: packageJson.version,
      dashboardEndpoint: advertisedOrigin,
      localDashboardEndpoint: localOrigin,
      publicDashboardEndpoint: advertisedOrigin,
      mcpEndpoint: mcp ? mcpEndpoint : null,
      accessUrl: advertisedAddress,
      logDirectory: paths.logDirectory,
      authenticationMode,
    });
    writeCliLine("Service access URL: worktree-switcher service url");
  } else {
    writeCliLine(translate(locale, "cli.accessLink", { url: advertisedAddress }));
  }
  writeCliLine(translate(locale, "cli.logs", { path: paths.logDirectory }));
  if (!serviceMode) writeCliLine(translate(locale, "cli.secret"));
  if (mcp) {
    writeCliLine(translate(locale, "cli.mcpListening", { url: mcpEndpoint }));
    writeCliLine(translate(locale, "cli.mcpConfig"));
  }

  if (!process.argv.includes("--no-open") && !serviceMode) openBrowser(interactiveAddress);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    writeCliLine(translate(locale, "cli.stopping"));
    try {
      const listeners = await Promise.allSettled([mcp?.close(), controller.close()]);
      const listenerFailures = listeners.filter((result) => result.status === "rejected");
      let serviceFailure: unknown = null;
      try {
        await service.shutdown();
      } catch (error) {
        serviceFailure = error;
      }
      const failures = [...listenerFailures.map((result) => result.reason), ...(serviceFailure ? [serviceFailure] : [])];
      if (failures.length) throw new AggregateError(failures, "Controller shutdown did not complete cleanly.");
    } finally {
      if (serviceMode) removeServiceAccess(paths.serviceAccessPath);
      controllerLock.release();
    }
  };
  const handleSignal = () => void shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}

async function handleServiceCommand(args: string[], paths: ReturnType<typeof resolveAppPaths>): Promise<void> {
  const action = args[0] ?? "status";
  const manager = new UserServiceManager();
  if (action === "install") {
    const entrypointPath = realpathSync(resolve(process.argv[1]));
    if (extname(entrypointPath) !== ".js") {
      throw new Error("Build Worktree Switcher first, then install the service with: node dist/cli/index.js service install");
    }
    const defaultWebRoot = resolve(fileURLToPath(new URL("../../out", import.meta.url)));
    const webRoot = resolve(option("--web-root", args) ?? defaultWebRoot);
    if (!existsSync(webRoot)) throw new Error(`Static dashboard not found at ${webRoot}. Run pnpm build first.`);
    const port = validatedPort(option("--port", args) ?? "47831", "dashboard");
    const mcpPort = validatedPort(option("--mcp-port", args) ?? "47832", "MCP");
    const host = option("--host", args) ?? "0.0.0.0";
    const browseRoot = resolve(option("--browse-root", args) ?? homedir());
    const memoryWarningMiB = optionalPositiveNumber(option("--memory-warning-mib", args), "Memory warning threshold");
    const configuredPublicOrigin = option("--public-url", args);
    const publicOrigin = configuredPublicOrigin ? parsePublicControllerOrigin(configuredPublicOrigin) : undefined;
    validatePublicControllerBackend(host, publicOrigin);
    mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
    const startArguments = buildServiceStartArguments({
      host,
      port,
      mcpPort,
      browseRoot,
      dataDirectory: paths.dataDirectory,
      stateDirectory: paths.stateDirectory,
      webRoot,
      noMcp: args.includes("--no-mcp"),
      memoryWarningMiB,
      publicOrigin,
    });
    const result = manager.install({
      nodePath: resolve(process.execPath),
      entrypointPath,
      workingDirectory: resolve(fileURLToPath(new URL("../../", import.meta.url))),
      startArguments,
      stateDirectory: paths.stateDirectory,
      refresh: args.includes("--refresh"),
    });
    writeCliLine(`${result.changed ? "Installed" : "Service already up to date"}: ${result.definitionPath}`);
    writeCliLine("The user service is enabled and started. Run worktree-switcher service status for details.");
    if (manager.kind === "systemd") {
      writeCliLine("It starts with your user session. Pre-login startup requires administrator-approved loginctl enable-linger; this command never enables it.");
    }
    return;
  }
  if (action === "status") {
    await printServiceStatus(manager, paths);
    return;
  }
  if (action === "start") manager.start();
  else if (action === "stop") manager.stop();
  else if (action === "restart") manager.restart();
  else if (action === "uninstall") {
    const result = manager.uninstall();
    writeCliLine(`${result.removed ? "Removed" : "Service was not installed"}: ${result.definitionPath}`);
    writeCliLine("Application data, credentials, and logs were preserved.");
    return;
  } else if (action === "url" || action === "open") {
    const access = readServiceAccess(paths.serviceAccessPath);
    if (!access || !processExists(access.pid)) throw new Error("The service is not running or its access record is stale.");
    if (action === "open") openBrowser(access.accessUrl);
    else writeCliLine(access.accessUrl);
    return;
  } else {
    throw new Error("Available service commands: install, status, start, stop, restart, url, open, uninstall");
  }
  writeCliLine(`Service ${action} requested.`);
  await printServiceStatus(manager, paths);
}

async function printServiceStatus(manager: UserServiceManager, paths: ReturnType<typeof resolveAppPaths>): Promise<void> {
  const status = manager.status();
  const access = readServiceAccess(paths.serviceAccessPath);
  const currentAccess = access && status.pid === access.pid ? access : null;
  writeCliLine(`Service: ${status.installed ? status.state : "not installed"} (${status.platform})`);
  writeCliLine(`Definition: ${status.definitionPath}`);
  if (status.pid) writeCliLine(`Controller PID: ${status.pid}`);
  if (status.uptimeSeconds !== null) writeCliLine(`Uptime: ${formatDuration(status.uptimeSeconds)}`);
  if (status.residentMemoryBytes !== null) writeCliLine(`Controller memory (RSS): ${formatBytes(status.residentMemoryBytes)}`);
  if (status.cpuPercent !== null) writeCliLine(`Controller CPU: ${status.cpuPercent.toFixed(1)}%`);
  if (status.restarts !== null) writeCliLine(`Restarts: ${status.restarts}`);
  if (status.lastExitStatus !== null) writeCliLine(`Last exit status: ${status.lastExitStatus}`);
  if (currentAccess) {
    writeCliLine(`Version: ${currentAccess.version}`);
    writeCliLine(`Dashboard: ${publicDashboardEndpoint(currentAccess)}`);
    if (currentAccess.mcpEndpoint) writeCliLine(`MCP: ${currentAccess.mcpEndpoint}`);
    writeCliLine(`Logs: ${currentAccess.logDirectory}`);
    writeCliLine("Access URL: worktree-switcher service url");
    try {
      const token = controllerAccessToken(currentAccess);
      if (token) {
        const response = await fetch(`${localDashboardEndpoint(currentAccess)}/api/dashboard`, {
          headers: { "X-Worktree-Switcher-Token": token },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const dashboard = await response.json() as ControllerDashboardResponse;
          const capacity = dashboard.capacity;
          if (capacity) {
            writeCliLine(`Server capacity: ${capacity.used}/${capacity.enabled ? capacity.limit : "unlimited"}`);
            if (capacity.holders.length) writeCliLine(`Capacity holders: ${capacity.holders.map(({ projectName }) => projectName).join(", ")}`);
          }
        }
      }
    } catch {
      writeCliLine("Server capacity: unavailable");
    }
  } else {
    writeCliLine(`Logs: ${paths.logDirectory}`);
  }
}

function validatedPort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${label} port.`);
  return port;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${remainder}s`].filter(Boolean).join(" ");
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function listen(server: import("node:http").Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
}

function findLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
