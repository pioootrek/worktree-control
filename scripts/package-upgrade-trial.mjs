import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { installProductionPrefix, productionInstallEnvironment, verifyInstalledDriver } from "./package-install.mjs";
import { verifyHistoricalArtifact, verifyTrialFiles } from "./package-artifact.mjs";
const exec = promisify(execFile);
const oldArtifact = process.env.WORKTREE_SWITCHER_TEST_OLD_ARTIFACT, oldProvenance = process.env.WORKTREE_SWITCHER_TEST_OLD_PROVENANCE;
const historical = await verifyHistoricalArtifact(oldArtifact, oldProvenance);
const root = await mkdtemp(join(tmpdir(), "wts-upgrade-trial-"));
try {
  const output = join(root, "artifact");
  await exec(process.execPath, ["scripts/package-trial.mjs", "--output", output], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const provenance = JSON.parse(await readFile(join(output, "provenance.json"), "utf8"));
  if (provenance.source.dirty) throw new Error("Installed upgrade acceptance requires committed clean current source.");
  await verifyTrialFiles(output, provenance);
  let report;
  if (process.argv.includes("--driver-only")) {
    const packageRoot = await installProductionPrefix(join(output, provenance.artifact.filename), join(root, "current-prefix"), root, await productionInstallEnvironment(root), exec);
    const result = await verifyInstalledDriver("scripts/package-upgrade-driver.mjs", packageRoot, [oldArtifact, oldProvenance], root);
    report = { mode: "driver-only-debug-not-full-smoke", currentProvenance: provenance, historicalProvenance: historical, installedAcceptance: result };
  } else {
    const result = await exec(process.execPath, [join(output, provenance.files.smoke), "--tarball", join(output, provenance.artifact.filename), "--sha256", provenance.artifact.sha256, "--verification-script", "scripts/package-upgrade-driver.mjs", "--verification-old-artifact", oldArtifact, "--verification-old-provenance", oldProvenance], { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
    report = { mode: "full-installed-smoke-and-upgrade", currentProvenance: provenance, historicalProvenance: historical, installedAcceptance: JSON.parse(result.stdout) };
  }
  const reportPath = process.env.WORKTREE_SWITCHER_TEST_UPGRADE_REPORT;
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  const evidence = report.installedAcceptance.additionalVerification?.evidence ?? report.installedAcceptance.evidence;
  console.log(JSON.stringify({ mode: report.mode, current: provenance.source, artifact: provenance.artifact, historical: historical.source, historicalArtifact: historical.artifact,
    schemas: evidence.schemas, steps: evidence.steps.map(step => ({ name: step.name, ok: step.ok })), cleanup: evidence.cleanup, smokeSteps: report.installedAcceptance.steps?.length ?? null,
    faults: evidence.faults.map(fault => fault.point), allLocalCopiesRemoved: evidence.removedLocalCopies, exactHistoricalAuditPreserved: evidence.auditPreservation, durationMs: evidence.durationMs }));
} catch (error) {
  // Child diagnostics come only from trusted local drivers; no application raw errors.
  console.error(error.stderr?.slice(-8000) ?? error.message ?? "Installed upgrade trial failed."); process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
