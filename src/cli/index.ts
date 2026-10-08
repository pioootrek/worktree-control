#!/usr/bin/env node
import { controllerRestoreBoundary } from "../server/restore-requests";
import { parseUserBackupOptions } from "./user-backup-options";
import { UserSchedules, BackupOperations, RestoreOperations, recoverBackupHandoff, finishBackupHandoff, assertBackupHandoffCompleted } from "../server/modules/backups";
import { backupAdminHandler } from "../server/backup-admin";
import { parseBackupPolicyOptions, validateBackupPolicyDestination } from "./backup-policy-options";
import { parseRemoteBackupOptions } from "./remote-backup-options";
import { ResticBackupTransport } from "../server/infrastructure/backups";
import type { ControllerLock } from "../server/controller-lock";
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
import { runBackupMonitor } from "./backup-monitor";
import { pairingUrl } from "./pairing-url";
import { openProjectGateway, runDoctorCommand, runProjectCommand } from "./project-management";
import { controllerAccessToken, localDashboardEndpoint, publicDashboardEndpoint, readServiceAccess, removeServiceAccess, writeServiceAccess } from "./service-access";
import { mcpConfigToken } from "./mcp-config";
import { mcpDiagnosticsAdminHandler } from "../server/mcp-diagnostics-admin";
import { requestAdminSocket, listenAdminSocket, type AdminSocketServer } from "../server/admin-socket";
import { buildServiceStartArguments } from "./service-install";
import { resolveServiceInstallArguments, serviceSettingChanges, validateServiceCommand } from "./service-options";
import { legacyServiceWarning, renderLaunchAgent, renderSystemdUnit, UserServiceManager, type ServiceInstallOptions } from "./service-manager";
import { ControlService } from "../server/control-service";
import { acquireControllerLock } from "../server/controller-lock";
import { DirectoryBrowser } from "../server/directory-browser";
import { EventStream } from "../server/events";
import { FileLogWriter } from "../server/log-writer";
import { ProjectLifecycle } from "../server/modules/lifecycle";
import { AuthenticationService } from "../server/modules/authentication";
import { authenticationAdminHandler } from "../server/authentication-admin";
import { IdentityService } from "../server/modules/identity";
import { KnowledgeAttachmentService, loadAttachmentLimits, KnowledgeService, KnowledgeError, knowledgeFailure } from "../server/modules/knowledge";
import { createMcpControllerServer } from "../server/mcp-http-server";
import { SystemGitWorktreeReader } from "../server/git-worktrees";
import { createControllerServer } from "../server/http-server";
import { resolveAppPaths } from "../server/paths";
import { ProcessManager } from "../server/process-manager";
import { loadOrCreateSecret } from "../server/secret-file";
import { openControllerStore } from "../server/controller-storage";
import { parseMigrationBackupOptions } from "./migration-backup-options";
import { mcpSessionLimits, parseMcpSessionOptions } from "./mcp-session-options";
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

async function main(retainedLock?: ControllerLock): Promise<void> {
  const locale = systemLocale(process.env);
  const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "start";
  if (command === "service") {
    const args = process.argv.slice(3);
    validateServiceCommand(args);
    await handleServiceCommand(args, resolveAppPaths(option("--data-dir", args), option("--state-dir", args)));
    return;
  }
  if (command === "backup" && process.argv[3] === "monitor") {
    const result = await runBackupMonitor(process.argv.slice(4));
    writeCliLine(JSON.stringify(result, null, 2)); process.exitCode = result.exitCode; return;
  }
  const backupPolicy = parseBackupPolicyOptions(process.argv.slice(2), command === "start");
  const remoteBackup = parseRemoteBackupOptions(process.argv.slice(2), command === "start");
  if (command === "start" && remoteBackup.loaded && !backupPolicy.directory) throw new Error("Remote backup transfer requires --backup-dir.");
  const userBackupPolicy = parseUserBackupOptions(process.argv.slice(2), command === "start");
  const migrationBackup = parseMigrationBackupOptions(process.argv.slice(2), command === "start");
  const mcpSessionOptions = parseMcpSessionOptions(process.argv.slice(2), command === "start");
  validateBackupPolicyDestination(backupPolicy);
  const knowledgeArgs = command === "knowledge" ? parseKnowledgeCommandArgs(process.argv.slice(3)) : undefined;
  const paths = knowledgeArgs
    ? resolveAppPaths(knowledgeArgs.dataDir, knowledgeArgs.stateDir)
    : resolveAppPaths(option("--data-dir"), option("--state-dir"));
  if (["knowledge", "auth", "identity", "backup", "project", "doctor"].includes(command) || (command === "config" && process.argv[3] === "mcp")) assertBackupHandoffCompleted(paths.databasePath);
  if (command === "mcp" && process.argv[3] === "diagnostics") {
    if (withoutPathOptions(process.argv.slice(4)).length) throw new Error("Usage: mcp diagnostics [--data-dir PATH] [--state-dir PATH]");
    const result = await requestAdminSocket(paths.adminSocketPath, { command: "mcp-diagnostics" }, 5000, 64 * 1024);
    writeCliLine(JSON.stringify(result, null, 2));
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
    await runAuthCommand(withoutPathOptions(process.argv.slice(3)), paths, { write: writeCliLine });
    return;
  }
  if (command === "identity") {
    await runIdentityCommand(process.argv.slice(3), paths, { write: writeCliLine });
    return;
  }
  if (command === "backup") {
    await runBackupCommand(withoutPathOptions(process.argv.slice(3)), paths, packageJson.version, writeCliLine);
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
    const token = await mcpConfigToken(paths);
    writeCliLine(JSON.stringify({
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
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

  const memoryWarningMiB = optionalPositiveNumber(option("--memory-warning-mib"), "Memory warning threshold");
  const knowledgeLimits = loadAttachmentLimits(paths.dataDirectory);
  const controllerLock = retainedLock ?? acquireControllerLock(paths.controllerLockPath);
  let maintenance = false;

  const events = new EventStream();
  let store;
  try {
    const handoff = recoverBackupHandoff(paths.databasePath, paths.knowledgeAttachmentDirectory, backupPolicy);
    store = await openControllerStore(paths.databasePath, { ...migrationBackup, applicationVersion: packageJson.version, attachmentDirectory: paths.knowledgeAttachmentDirectory });
    if (handoff) finishBackupHandoff(paths.databasePath, handoff, store);
  } catch (error) { store?.close(); controllerLock.release(); throw error; }
  const authentication = new AuthenticationService(store);
  let logs: FileLogWriter;
  try {
    authentication.assertStartupPolicy();
    logs = new FileLogWriter(paths.logDirectory);
  } catch (error) {
    store.close();
    controllerLock.release();
    throw error;
  }
  let userSchedules: UserSchedules | undefined;
  let backups: BackupOperations;
  try {
    backups = new BackupOperations(backupPolicy, {
      databasePath: paths.databasePath, attachmentDirectory: paths.knowledgeAttachmentDirectory, applicationVersion: packageJson.version,
      source: store, estimateBytes: () => store.backupEstimateBytes(),
      authorize: actor => authentication.isCurrentInstallationActor(actor), maintenance: () => maintenance,
      remoteTransport: remoteBackup.loaded ? new ResticBackupTransport(remoteBackup.loaded) : undefined,
    });
  } catch (error) { await logs.close(); store.close(); controllerLock.release(); throw error; }
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
  try {
    const restoreBoundary = controllerRestoreBoundary(paths.databasePath);
    userSchedules = new UserSchedules(userBackupPolicy, backups, {
      restoreGeneration: () => restoreBoundary.generation,
      authorize: (actor, projectId) => {
        identity.describeIdentity(actor);
        if (restoreBoundary.createdAt && (store.getCredentialForAuthentication(actor.credentialId)?.createdAt ?? "") <= restoreBoundary.createdAt) throw new Error("Schedule credential requires post-restore renewal.");
        if (projectId) {
          identity.authorizeKnowledge(actor, projectId, "knowledge:read");
          identity.authorizeKnowledge(actor, projectId, "knowledge:export");
        }
      },
      projectName: projectId => store.getKnowledgeProject(projectId)?.name ?? null,
      exportDiscussions: (projectId, maxBytes) => store.exportUserDiscussions(projectId, maxBytes),
    });
  } catch (error) { userSchedules?.close(); await backups.close(); await logs.close(); store.close(); controllerLock.release(); throw error; }
  const attachments = new KnowledgeAttachmentService(store, identity, paths.knowledgeAttachmentDirectory, knowledgeLimits);
  const knowledge = new KnowledgeService(store, identity, undefined, undefined, events.publishKnowledge, attachments);
  const service = new ControlService(store, new SystemGitWorktreeReader(), processes, logs, undefined, storage, undefined, undefined, tests, lifecycle, knowledge);
  const restores = new RestoreOperations(backups, paths.databasePath, paths.knowledgeAttachmentDirectory, {
    authentication: () => store.getAuthenticationPolicy(),
    enterMaintenance: () => { maintenance = true; lifecycle.closeAdmission(); },
    restart: async execute => {
      await shutdown(true);
      execute();
      await main(controllerLock);
    },
    failure: error => { console.error(error instanceof Error ? error.message : "Restore handoff failed."); void shutdown().finally(() => { controllerLock.release(); process.exit(1); }); },
  });
  const accessToken = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(8).toString("hex");
  const mcpSessions = new Set<string>();
  const mcpEndpoint = `http://127.0.0.1:${mcpPort}/mcp`;
  const mcp = process.argv.includes("--no-mcp") ? null : createMcpControllerServer({
    service,
    port: mcpPort,
    accessToken: loadOrCreateSecret(paths.mcpTokenPath),
    sessionLimits: mcpSessionLimits(mcpSessionOptions),
    identity,
    authentication: {
      mode: () => maintenance ? "better-auth" : authentication.mode(),
      authenticateInstallation: token => maintenance ? null : authentication.authenticateInstallation(token),
      anonymousInstallation: () => maintenance ? null : authentication.anonymousInstallation(),
    },
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
  const readMcpDiagnostics = async () => ({
    mcp: mcp ? await mcp.diagnosticsSnapshot() : null,
    status: mcp ? "enabled" as const : "disabled" as const,
    statusWaits: service.statusWaitDiagnostics(),
  });
  const controller = createControllerServer({
    service,
    directoryBrowser: new DirectoryBrowser(option("--browse-root") ?? homedir()),
    events,
    mcpDiagnostics: readMcpDiagnostics,
    mcpStatus: () => ({
      phase: !mcp ? "disabled" : mcp.server.listening ? "running" : "stopped",
      endpoint: mcp ? mcpEndpoint : null,
      transport: "streamable-http",
      network: "loopback",
      authentication: authentication.mode() === "open" ? "none" : "bearer",
      activeSessions: mcpSessions.size,
    }),
    webRoot,
    host,
    port,
    accessToken,
    identity,
    authentication,
    publicOrigin,
    backups, restores, userSchedules, maintenance: () => maintenance,
  });
  try {
    await listen(controller.server, port, host);
    if (mcp) await listen(mcp.server, mcpPort, "127.0.0.1");
  } catch (error) {
    userSchedules?.close(); await backups.close();
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
  const accessLink = (origin: string, mode = authentication.mode()) => mode === "legacy"
    ? pairingUrl(origin, accessToken, sessionId)
    : new URL("/", origin).toString();
  const advertisedAddress = accessLink(advertisedOrigin);
  const interactiveAddress = accessLink(interactiveControllerOrigin(localOrigin, publicOrigin));
  const serviceMode = process.argv.includes("--service-mode");
  const startedAt = new Date().toISOString();
  const recordServiceAccess = () => writeServiceAccess(paths.serviceAccessPath, {
    pid: process.pid,
    startedAt,
    version: packageJson.version,
    dashboardEndpoint: advertisedOrigin,
    localDashboardEndpoint: localOrigin,
    publicDashboardEndpoint: advertisedOrigin,
    mcpEndpoint: mcp ? mcpEndpoint : null,
    accessUrl: accessLink(advertisedOrigin),
    logDirectory: paths.logDirectory,
    authenticationMode: authentication.mode(),
  });
  let adminSocket: AdminSocketServer;
  try {
    const authenticationHandler = authenticationAdminHandler({
      authentication,
      closeMcpSessions: async () => { await mcp?.closeSessions(); },
      disconnectEvents: () => events.disconnectAll(),
      onPolicyChanged: (command) => {
        if (serviceMode) recordServiceAccess();
        logs.controller("authentication.policy_changed", { command, mode: authentication.mode() });
      },
    });
    const backupHandler = backupAdminHandler(backups, restores, userSchedules);
    const mcpDiagnosticsHandler = mcpDiagnosticsAdminHandler(readMcpDiagnostics);
    adminSocket = await listenAdminSocket(paths.adminSocketPath, body => {
      if (body && typeof body === "object" && "command" in body && (body.command === "backup" || body.command === "backup-remote" || body.command === "backup-monitor" || body.command === "user-export-recovery")) return backupHandler(body);
      if (body && typeof body === "object" && "command" in body && body.command === "mcp-diagnostics") {
        return mcpDiagnosticsHandler(body);
      }
      if (maintenance) throw new Error("Controller is in maintenance.");
      return authenticationHandler(body);
    });
  } catch (error) {
    userSchedules?.close(); await backups.close();
    await mcp?.close();
    await controller.close();
    await service.shutdown();
    controllerLock.release();
    throw error;
  }
  writeCliLine(translate(locale, "cli.listening", { host, port }));
  if (serviceMode) {
    recordServiceAccess();
    writeCliLine("Service access URL: worktree-control service url");
  } else {
    writeCliLine(translate(locale, "cli.accessLink", { url: advertisedAddress }));
  }
  writeCliLine(translate(locale, "cli.logs", { path: paths.logDirectory }));
  if (authenticationMode === "open") writeCliLine(translate(locale, "cli.openMode", { address: `${host}:${port}` }));
  else if (authenticationMode === "token") writeCliLine(translate(locale, "cli.tokenMode"));
  else if (!serviceMode) writeCliLine(translate(locale, "cli.secret"));
  if (mcp) {
    writeCliLine(translate(locale, "cli.mcpListening", { url: mcpEndpoint }));
    writeCliLine(translate(locale, "cli.mcpConfig"));
  }

  if (!process.argv.includes("--no-open") && !serviceMode) openBrowser(interactiveAddress);
  backups.start();
  userSchedules.start();
  let closing = false;
  const shutdown = async (handoff = false) => {
    if (closing) return;
    closing = true;
    maintenance = true;
    // Cancel pending starts before closing listeners, which wait for their HTTP responses.
    service.closeAdmission();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    writeCliLine(translate(locale, "cli.stopping"));
    try {
      let backupFailure: unknown = null;
      try { userSchedules?.close(); await backups.close(); } catch (error) { backupFailure = error; }
      const listeners = await Promise.allSettled([mcp?.close(), controller.close(), adminSocket.close()]);
      const listenerFailures = listeners.filter((result) => result.status === "rejected");
      let serviceFailure: unknown = null;
      try {
        await service.shutdown();
      } catch (error) {
        serviceFailure = error;
      }
      const failures = [...(backupFailure ? [backupFailure] : []), ...listenerFailures.map((result) => result.reason), ...(serviceFailure ? [serviceFailure] : [])];
      if (failures.length) throw new AggregateError(failures, "Controller shutdown did not complete cleanly.");
    } finally {
      if (serviceMode) removeServiceAccess(paths.serviceAccessPath);
      if (!handoff) controllerLock.release();
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
    const requested = args;
    const installed = manager.readInstallStartArguments();
    const legacyInstalled = existsSync(manager.legacyDefinitionPath);
    const resolved = resolveServiceInstallArguments(requested, installed);
    args = resolved.args;
    paths = resolveAppPaths(option("--data-dir", args), option("--state-dir", args));
    const migrationBackup = parseMigrationBackupOptions(args);
    const backupPolicy = parseBackupPolicyOptions(args);
    validateBackupPolicyDestination(backupPolicy);
    const userBackupPolicy = parseUserBackupOptions(args);
    const remoteBackup = parseRemoteBackupOptions(args);
    if (remoteBackup.loaded && !backupPolicy.directory) throw new Error("Remote backup transfer requires --backup-dir.");
    const entrypointPath = realpathSync(resolve(process.argv[1]));
    if (extname(entrypointPath) !== ".js") {
      throw new Error("Build Worktree Control first, then install the service with: node dist/cli/index.js service install");
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
      mcpSessionOptions: parseMcpSessionOptions(args),
      ...migrationBackup,
      backupPolicy, userBackupPolicy, remoteBackupOptions: remoteBackup,
    });
    const installOptions: ServiceInstallOptions = {
      nodePath: resolve(process.execPath),
      entrypointPath,
      workingDirectory: resolve(fileURLToPath(new URL("../../", import.meta.url))),
      startArguments,
      stateDirectory: paths.stateDirectory,
      refresh: requested.includes("--refresh"),
    };
    const changes = serviceSettingChanges(installed, args, startArguments);
    for (const change of changes) writeCliLine(`Service setting change: ${change}`);
    if (requested.includes("--print")) {
      writeCliLine(manager.kind === "systemd" ? renderSystemdUnit(installOptions) : renderLaunchAgent(installOptions));
      return;
    }
    if (legacyInstalled && changes.length && !requested.includes("--yes")) {
      throw new Error("Legacy service settings would change. Review service install --print, then repeat with --yes to accept the listed changes.");
    }
    manager.assertInstalledServiceConfiguration();
    if (legacyInstalled || (installed && installOptions.refresh)) {
      writeCliLine("Warning: installing this upgrade restarts the controller and stops its managed servers and active tests. Reacquire claims and start servers after the upgrade.");
    }
    mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
    const result = manager.install(installOptions);
    writeCliLine(`${result.changed ? "Installed" : "Service already up to date"}: ${result.definitionPath}`);
    if (result.legacy) {
      writeCliLine(`Migrated the legacy worktree-switcher service: ${result.legacy.wasActive ? "stopped, " : ""}disabled and removed ${result.legacy.definitionPath}`);
      for (const path of result.legacy.migratedDropIns) writeCliLine(`Copied legacy systemd drop-in to ${path}`);
      if (result.legacy.retainedDropInDirectory) {
        writeCliLine(`Warning: kept ${result.legacy.retainedDropInDirectory} because some entries could not be migrated verbatim. Review it against ${result.definitionPath}.d and remove it afterwards.`);
      }
    }
    writeCliLine("The user service is enabled and started. Run worktree-control service status for details.");
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
    if (result.legacyDefinitionPath) writeCliLine(`Removed the legacy worktree-switcher service: ${result.legacyDefinitionPath}`);
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
  if (status.legacyDefinitionPath) {
    writeCliLine(legacyServiceWarning(status.legacyDefinitionPath));
  }
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
    writeCliLine("Access URL: worktree-control service url");
    try {
      const token = controllerAccessToken(currentAccess);
      if (token || currentAccess.authenticationMode === "open") {
        const response = await fetch(`${localDashboardEndpoint(currentAccess)}/api/dashboard`, {
          headers: token ? { "X-Worktree-Control-Token": token } : {},
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

/** Drops the global --data-dir/--state-dir options that `paths` already consumed. */
function withoutPathOptions(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--data-dir" || args[index] === "--state-dir") index++;
    else result.push(args[index]!);
  }
  return result;
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
  console.error(error instanceof KnowledgeError ? JSON.stringify(knowledgeFailure(error).body) : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
