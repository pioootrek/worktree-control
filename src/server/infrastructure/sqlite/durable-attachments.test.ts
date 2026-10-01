import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeAttachmentService, executeHubImport, importKnowledgeProject, type HubImportPlan } from "@/server/modules/knowledge";
import { SqliteStateStore } from "./index";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("attachment publication process interruption", () => {
  for (const operation of ["upload", "hub", "project"]) {
    it.each(["before-file", "after-file", "before-commit"])(`${operation} recovers after SIGKILL at %s without a missing committed object`, async point => {
      const root = mkdtempSync(join(dirname(process.cwd()), ".attachment-crash-")); roots.push(root);
      const child = fork(fileURLToPath(new URL("./fixtures/attachment-crash-worker.ts", import.meta.url)), [root, operation, point], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 5000);
      try {
        const message = once(child, "message", { signal: abort.signal });
        const ended = once(child, "exit").then(() => { throw new Error(`Crash fixture exited early: ${stderr}`); });
        expect((await Promise.race([message, ended]))[0]).toEqual({ point, operation });
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); expect((await ended)[1]).toBe("SIGKILL"); }
      }
      const metadata = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { token: string; projectId: string; taskId: string; sha256: string; size: number };
      const directory = join(root, "attachments"), path = join(directory, metadata.sha256.slice(0, 2), metadata.sha256);
      expect(existsSync(path)).toBe(point !== "before-file");
      const store = new SqliteStateStore(join(root, "state.sqlite3"));
      try {
        const identity = new IdentityService(store), owner = identity.authenticateBearer(metadata.token);
        const target = operation === "hub" ? "imported" : metadata.projectId;
        expect(store.exportKnowledgeProject(target)?.attachments ?? []).toHaveLength(0);
        const bytes = Buffer.from("process interruption attachment");
        if (operation === "upload") new KnowledgeAttachmentService(store, identity, directory).upload(target, "task", metadata.taskId, { filename: "proof.txt", mediaType: "text/plain", data: bytes, idempotencyKey: "upload" }, owner);
        if (operation === "hub") executeHubImport(store, identity, owner, { plan: JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as HubImportPlan, targetProjectId: target, targetProjectName: "Imported", attachmentDirectory: directory, batchId: "crash-batch" }, undefined, plan => plan, () => bytes);
        if (operation === "project") importKnowledgeProject(store, identity, join(root, "export"), directory, owner);
        expect(store.exportKnowledgeProject(target)?.attachments).toHaveLength(1);
        expect(readFileSync(path)).toEqual(bytes);
      } finally { store.close(); }
      expect(existsSync(`${join(root, "state.sqlite3")}.owner.lock`)).toBe(false);
    });
  }
});
