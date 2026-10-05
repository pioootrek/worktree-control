import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { planHubImportAgainstValidator } from "./hub-import-plan";

const roots: string[] = [];
function commit(root: string, message = "fixture"): string {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "hub-import-source-")); roots.push(root);
  cpSync(join(process.cwd(), "tests", "fixtures", "knowledge-hub"), root, { recursive: true });
  for (const name of ["schema.json", "done-schema.json", "note-schema.json", "docs-header-schema.json"]) writeFileSync(join(root, "docs", "backlog", name), "{\"type\":\"object\"}");
  const marker = join(root, "imported-script-ran"), sourceBin = join(root, "docs", "backlog", "bin"); mkdirSync(sourceBin); writeFileSync(join(sourceBin, "hub.py"), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("bad")\n`);
  return { root, commit: commit(root), marker };
}
function validator() {
  const root = mkdtempSync(join(tmpdir(), "hub-validator-")); roots.push(root); mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "hub.py"), `import argparse,json,pathlib,subprocess
PROJECT_DOCS_SCHEMA_FILE='docs-header-schema.json'
def item_files(source): return [PROJECT_DOCS_SCHEMA_FILE]
def main():
 p=argparse.ArgumentParser();p.add_argument('command');p.add_argument('--backlog-dir');a=p.parse_args()
 root=subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=pathlib.Path(a.backlog_dir)).decode().strip();c=json.loads((pathlib.Path(a.backlog_dir)/'config.json').read_text());d=c.get('docs_dir');ok=(not d or (pathlib.Path(root)/d).exists()) and not (pathlib.Path(a.backlog_dir)/'force-invalid').exists() and item_files(None)==[];print('passed' if ok else 'failed');return 0 if ok else 1
`);
  return { root, commit: commit(root, "validator") };
}
function plan(source: ReturnType<typeof repository>, trusted: ReturnType<typeof validator>) {
  return planHubImportAgainstValidator({ repository: source.root, commit: source.commit, sourceId: "fixture", validatorRepository: trusted.root }, trusted.commit);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("K6a Hub import planning", () => {
  it("runs a trusted validator in an isolated Git worktree and writes no imported data", () => {
    const source = repository(), trusted = validator(); mkdirSync(join(source.root, "handbook")); writeFileSync(join(source.root, "handbook", "overview.md"), "# Docs\n");
    const configPath = join(source.root, "docs", "backlog", "config.json"); const config = JSON.parse(readFileSync(configPath, "utf8")); config.docs_dir = "handbook"; writeFileSync(configPath, JSON.stringify(config)); source.commit = commit(source.root, "configured docs");
    const state = join(source.root, "controller.sqlite3"); writeFileSync(state, "unchanged"); const report = plan(source, trusted);
    expect(report.validator.valid).toBe(true); expect(report.mappings).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePath: "handbook/overview.md", sourceKind: "document", disposition: "source_only" })]));
    expect(readFileSync(state, "utf8")).toBe("unchanged"); expect(existsSync(source.marker)).toBe(false);
  });

  it("reports nested note.json attachments and stable location-independent hashes", () => {
    const source = repository(), trusted = validator(); const nested = join(source.root, "docs", "backlog", "notes", "NOTE-20260913-synthetic-memory", "evidence", "note.json"); writeFileSync(nested, "{\"evidence\":true}"); source.commit = commit(source.root, "nested");
    const first = plan(source, trusted); const clone = mkdtempSync(join(tmpdir(), "source-clone-")); roots.push(clone); execFileSync("git", ["clone", "-q", source.root, clone]); const vclone = mkdtempSync(join(tmpdir(), "validator-clone-")); roots.push(vclone); execFileSync("git", ["clone", "-q", trusted.root, vclone]);
    const second = planHubImportAgainstValidator({ repository: clone, commit: source.commit, sourceId: "fixture", validatorRepository: vclone }, trusted.commit);
    expect(first).toMatchObject({mappingVersion:2}); expect(first.counts).toMatchObject({ tasks: 1, embeddedNotes: 1, done: 1, notes: 1, attachments: 3, schemas: 4, derived: 1, unresolvedRelations: 1, missing: 0 }); expect(first.mappings.find(item => item.sourcePath.endsWith("evidence/note.json"))).toMatchObject({ sourceKind: "attachment" }); expect(first.planHash).toBe(second.planHash);
  });

  it("blocks orphan attachments while retaining nested files under an imported note", () => {
    const source = repository(), trusted = validator();
    const orphanRoot = join(source.root, "docs", "backlog", "notes", "NOTE-orphan");
    mkdirSync(join(orphanRoot, "evidence"), { recursive: true });
    writeFileSync(join(orphanRoot, "proof.txt"), "proof");
    writeFileSync(join(orphanRoot, "evidence", "note.json"), "{}");
    source.commit = commit(source.root, "orphan attachments");
    const report = plan(source, trusted);
    expect(report.validator.valid).toBe(true);
    expect(report.missing.filter(item => item.reason === "attachment_parent_missing")).toEqual([
      { sourcePath: "docs/backlog/notes/NOTE-orphan/evidence/note.json", reference: "docs/backlog/notes/NOTE-orphan/note.json", blocking: true, reason: "attachment_parent_missing" },
      { sourcePath: "docs/backlog/notes/NOTE-orphan/proof.txt", reference: "docs/backlog/notes/NOTE-orphan/note.json", blocking: true, reason: "attachment_parent_missing" },
    ]);
    expect(report.mappings.some(item => item.targetKind === "attachment" && item.sourcePath.includes("NOTE-20260913-synthetic-memory/evidence/"))).toBe(true);
  });

  it("resolves done IDs and item_id aliases independently of file order and reports ambiguous completion aliases",()=>{
    const source=repository(),trusted=validator(),taskPath=join(source.root,"docs","backlog","feature","FEAT-20260913-synthetic-open.json"),task=JSON.parse(readFileSync(taskPath,"utf8"));task.links.related_ids=["DONE-20260913-synthetic-finished","FEAT-20260912-synthetic-finished"];writeFileSync(taskPath,JSON.stringify(task));source.commit=commit(source.root,"archived aliases");
    const resolved=plan(source,trusted);expect(resolved.unresolvedRelations).toEqual([]);
    const original=JSON.parse(readFileSync(join(source.root,"docs","backlog","done","DONE-20260913-synthetic-finished.json"),"utf8"));writeFileSync(join(source.root,"docs","backlog","done","DONE-20260914-duplicate.json"),JSON.stringify({...original,id:"DONE-20260914-duplicate"}));source.commit=commit(source.root,"ambiguous alias");
    expect(plan(source,trusted).conflicts).toEqual(expect.arrayContaining([expect.objectContaining({legacyId:"FEAT-20260912-synthetic-finished",blocking:true,reason:expect.stringContaining("ambiguous_done_item_id")})]));
  });

  it("reports malformed JSON once, duplicate IDs, custom enums, and missing attachments", () => {
    const source = repository(), trusted = validator(); const taskPath = join(source.root, "docs", "backlog", "feature", "FEAT-20260913-synthetic-open.json"); const task = JSON.parse(readFileSync(taskPath, "utf8")); task.status = "awaiting_legal"; writeFileSync(taskPath, JSON.stringify(task)); mkdirSync(join(source.root, "docs", "backlog", "fix"), { recursive: true }); writeFileSync(join(source.root, "docs", "backlog", "fix", "duplicate.json"), JSON.stringify({ ...task, status: "open" }));
    const notePath = join(source.root, "docs", "backlog", "notes", "NOTE-20260913-synthetic-memory", "note.json"); const note = JSON.parse(readFileSync(notePath, "utf8")); note.files.push("absent.txt"); writeFileSync(notePath, JSON.stringify(note)); writeFileSync(join(source.root, "docs", "backlog", "done", "broken.json"), "{"); source.commit = commit(source.root, "failures"); const report = plan(source, trusted);
    expect(report.missing.filter(item => item.reason === "invalid_json")).toHaveLength(1); expect(report.missing).toEqual(expect.arrayContaining([expect.objectContaining({ reference: "absent.txt" })])); expect(report.conflicts.map(item => item.reason)).toEqual(expect.arrayContaining([expect.stringContaining("duplicate_legacy_id"), "unsupported_task_status:awaiting_legal"])); expect(report.mappings.find(item => item.sourcePath === "docs/backlog/feature/FEAT-20260913-synthetic-open.json")?.sourceOnlyFields).toContain("status");
  });

  it("maps the standard Hub in-progress status explicitly and sorts paths by code point", () => {
    const source = repository(), trusted = validator(); const taskPath = join(source.root, "docs", "backlog", "feature", "FEAT-20260913-synthetic-open.json"); const task = JSON.parse(readFileSync(taskPath, "utf8")); task.status = "in-progress"; writeFileSync(taskPath, JSON.stringify(task)); writeFileSync(join(source.root, "docs", "backlog", "z.txt"), "z"); writeFileSync(join(source.root, "docs", "backlog", "ä.txt"), "a"); source.commit = commit(source.root, "known status"); const report = plan(source, trusted);
    expect(report.conflicts).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("in-progress") })])); expect(report.mappings.find(item => item.legacyId === task.id)?.valueMappings).toEqual([{ field: "status", sourceValue: "in-progress", targetValue: "in_progress" }]); expect(report.mappings.map(item => item.sourcePath).indexOf("docs/backlog/z.txt")).toBeLessThan(report.mappings.map(item => item.sourcePath).indexOf("docs/backlog/ä.txt"));
  });

  it("reports validator failures and enforces repository, ref, trust, traversal, and Git-mode boundaries", () => {
    const source = repository(), trusted = validator(); writeFileSync(join(source.root, "docs", "backlog", "force-invalid"), "x"); source.commit = commit(source.root, "invalid"); expect(plan(source, trusted).missing).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "hub_validation_failed" })]));
    expect(() => planHubImportAgainstValidator({ repository: "/definitely/missing", commit: source.commit, sourceId: "x", validatorRepository: trusted.root }, trusted.commit)).toThrow("source repository does not exist"); expect(() => planHubImportAgainstValidator({ repository: source.root, commit: "HEAD", sourceId: "x", validatorRepository: trusted.root }, trusted.commit)).toThrow("exact 40-character");
    writeFileSync(join(trusted.root, "dirty"), "x"); expect(() => plan(source, trusted)).toThrow("clean checkout"); rmSync(join(trusted.root, "dirty")); const configPath = join(source.root, "docs", "backlog", "config.json"); const config = JSON.parse(readFileSync(configPath, "utf8")); config.docs_dir = "../outside"; writeFileSync(configPath, JSON.stringify(config)); source.commit = commit(source.root, "unsafe"); expect(() => plan(source, trusted)).toThrow("safe repository-relative path"); config.docs_dir = ".git"; writeFileSync(configPath, JSON.stringify(config)); source.commit = commit(source.root, "git metadata"); expect(() => plan(source, trusted)).toThrow("safe repository-relative path");
    delete config.docs_dir; writeFileSync(configPath, JSON.stringify(config)); symlinkSync("config.json", join(source.root, "docs", "backlog", "linked.json")); source.commit = commit(source.root, "symlink"); expect(() => plan(source, trusted)).toThrow("unsupported Git entry");
  });

  it("applies the shared attachment policy separately from the source-file envelope", () => {
    const source = repository(), trusted = validator();
    expect(() => planHubImportAgainstValidator({ repository: source.root, commit: source.commit, sourceId: "policy", validatorRepository: trusted.root,
      limits: { fileBytes: 1, projectBytes: 1, projectFiles: 1 } }, trusted.commit)).toThrowError(expect.objectContaining({ code: "limit_exceeded", details: expect.objectContaining({ violations: expect.arrayContaining([expect.objectContaining({ constraint: "projectBytes" }), expect.objectContaining({ constraint: "projectFiles" })]) }) }));
  });

  it("enforces per-file and file-count limits before validation", () => {
    const oversized = repository(), trusted = validator(); writeFileSync(join(oversized.root, "docs", "backlog", "oversized.bin"), Buffer.alloc(10 * 1024 * 1024 + 1)); oversized.commit = commit(oversized.root, "oversized"); expect(() => plan(oversized, trusted)).toThrow("planning limits");
    const crowded = repository(); const directory = join(crowded.root, "docs", "backlog", "bulk"); mkdirSync(directory); for (let index = 0; index < 10_000; index += 1) writeFileSync(join(directory, `${index}.txt`), "x"); crowded.commit = commit(crowded.root, "crowded"); expect(() => plan(crowded, trusted)).toThrow("too many files");
  });
});
