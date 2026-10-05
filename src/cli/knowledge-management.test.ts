import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireControllerLock } from "../server/controller-lock";
import { calculateHubImportPlanHash, KnowledgeError, type HubImportMapping, type HubImportPlan } from "../server/modules/knowledge";
import { resolveAppPaths } from "../server/paths";
import { runAuthCommand } from "./auth-management";
import { parseKnowledgeCommandArgs, runHubImportExecuteCommand, runHubImportPlanCommand } from "./knowledge-management";

describe("knowledge CLI global paths", () => {
  it("extracts path flags around an operation without changing its JSON input", () => {
    const input = JSON.stringify({ projectId: "project", description: "--data-dir", idempotencyKey: "key" });
    expect(parseKnowledgeCommandArgs(["--data-dir", "/tmp/custom data", "create_task", "--json", input, "--state-dir", "/tmp/custom state"]))
      .toEqual({ args: ["create_task", "--json", input], dataDir: "/tmp/custom data", stateDir: "/tmp/custom state" });
  });

  it("keeps input-file values opaque", () => {
    expect(parseKnowledgeCommandArgs(["create_task", "--input-file", "--data-dir", "--state-dir", "/tmp/state"]))
      .toEqual({ args: ["create_task", "--input-file", "--data-dir"], stateDir: "/tmp/state" });
  });

  it.each([["projects", "--data-dir"], ["projects", "--state-dir", "--json", "{}"]])("rejects a missing global path in %j", (...args) => {
    expect(() => parseKnowledgeCommandArgs(args)).toThrow("requires a directory path");
  });
});

describe("knowledge plan-import CLI", () => {
  const report = { formatVersion: 1, planId: "plan", planHash: "hash" } as HubImportPlan;

  it("validates flags and required option pairs", () => {
    expect(() => runHubImportPlanCommand(["plan-import", "--unknown", "x"], vi.fn(), vi.fn())).toThrow("Usage: knowledge plan-import");
    expect(() => runHubImportPlanCommand(["plan-import", "--repository", "/repo"], vi.fn(), vi.fn())).toThrow("--commit is required");
  });

  it("writes the report without a controller token and prefixes planner failures", () => {
    const write = vi.fn(), planner = vi.fn(() => report);
    runHubImportPlanCommand(["plan-import", "--repository", "/repo", "--commit", "a".repeat(40), "--source-id", "source", "--validator-repository", "/hub"], write, planner);
    expect(planner).toHaveBeenCalledWith({ repository: "/repo", commit: "a".repeat(40), sourceId: "source", validatorRepository: "/hub" }); expect(JSON.parse(write.mock.calls[0]![0])).toEqual(report);
    expect(() => runHubImportPlanCommand(["plan-import", "--repository", "/repo", "--commit", "a".repeat(40), "--source-id", "source", "--validator-repository", "/hub"], vi.fn(), () => { throw new KnowledgeError("limit_exceeded", "too large"); })).toThrow("limit_exceeded: too large");
  });
});

describe("knowledge execute-import CLI",()=>{
  it("rejects unknown flags before opening the controller database",()=>{
    expect(()=>runHubImportExecuteCommand(["execute-import","--unknown","x"],{} as never)).toThrow("Usage: knowledge execute-import");
  });
});

describe("knowledge execute-import CLI authentication", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
  function planFile(root: string): string {
    const payload = { id: "FEAT-open", title: "Imported in open mode" };
    const mapping: HubImportMapping = { sourcePath: "docs/backlog/feature/FEAT-open.json", sourceKind: "task", targetKind: "task", legacyId: "FEAT-open", disposition: "mapped", sourceSha256: "a".repeat(64), size: 10, mappedFields: Object.keys(payload), sourceOnlyFields: [], originalPayload: payload };
    const plan: HubImportPlan = { formatVersion: 1, mappingVersion: 2, planId: "", planHash: "", source: { sourceId: "fixture", repository: "/source", commit: "d".repeat(40), backlogPath: "docs/backlog" }, validator: { repository: "/validator", commit: "e".repeat(40), command: ["validate"], valid: true, diagnostics: [] }, counts: { files: 1, bytes: 10, tasks: 1, embeddedNotes: 0, done: 0, notes: 0, attachments: 0, documents: 0, configurations: 0, schemas: 0, derived: 0, unclassified: 0, mapped: 1, sourceOnly: 0, skipped: 0, missing: 0, conflicts: 0, unresolvedRelations: 0 }, mappings: [mapping], missing: [], conflicts: [], unresolvedRelations: [], guarantees: { dataWritten: false, sourceReadFromCommit: true, importedRepositoryScriptsExecuted: false } };
    plan.planHash = calculateHubImportPlanHash(plan); plan.planId = `hub:fixture:${"d".repeat(40)}:${plan.planHash.slice(0, 16)}`;
    const file = join(root, "plan.json"); writeFileSync(file, JSON.stringify(plan)); return file;
  }
  const args = (file: string, target: string) => ["execute-import", "--plan-file", file, "--target-id", target, "--target-name", target];

  it("imports offline as the anonymous installation in open mode and requires a credential in token mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-import-cli-")); roots.push(root);
    const paths = resolveAppPaths(join(root, "data"), join(root, "state")), file = planFile(root), verifyPlan = (plan: HubImportPlan) => plan;
    const generated: string[] = [];
    await runAuthCommand(["token", "generate"], paths, { write: (line) => generated.push(line) });
    const { token } = JSON.parse(generated[0]!) as { token: string };
    await runAuthCommand(["mode", "set", "open"], paths, { write: () => {} });

    const lock = acquireControllerLock(paths.controllerLockPath);
    try { expect(() => runHubImportExecuteCommand(args(file, "open"), paths, { environment: {}, verifyPlan })).toThrow("already running"); }
    finally { lock.release(); }
    const openOutput: string[] = [];
    runHubImportExecuteCommand(args(file, "open"), paths, { environment: {}, verifyPlan, write: line => openOutput.push(line) });
    expect(JSON.parse(openOutput[0]!)).toMatchObject({ actorPrincipalId: "installation", authenticationMethod: "none" });
    const database = new Database(paths.databasePath, { readonly: true });
    expect(database.prepare("SELECT target_project_id, actor_principal_id, authentication_method, status FROM knowledge_import_batches").all())
      .toEqual([{ target_project_id: "open", actor_principal_id: "installation", authentication_method: "none", status: "published" }]);
    database.close();

    await runAuthCommand(["mode", "set", "token"], paths, { write: () => {} });
    expect(() => runHubImportExecuteCommand(args(file, "missing"), paths, { environment: {}, verifyPlan })).toThrow("WORKTREE_CONTROL_OWNER_TOKEN");
    expect(() => runHubImportExecuteCommand(args(file, "invalid"), paths, { environment: { WORKTREE_CONTROL_TOKEN: `${token}0` }, verifyPlan })).toThrow("Nieprawidłowe lub nieaktywne");
    const tokenOutput: string[] = [];
    runHubImportExecuteCommand(args(file, "token"), paths, { environment: { WORKTREE_CONTROL_TOKEN: token }, verifyPlan, write: line => tokenOutput.push(line) });
    expect(JSON.parse(tokenOutput[0]!)).toMatchObject({ actorPrincipalId: "installation", authenticationMethod: "installation_token" });
  });
});
