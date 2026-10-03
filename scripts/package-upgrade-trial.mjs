import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
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
  const result = await exec(process.execPath, [join(output, provenance.files.smoke), "--tarball", join(output, provenance.artifact.filename), "--sha256", provenance.artifact.sha256, "--verification-script", "scripts/package-upgrade-driver.mjs", "--verification-old-artifact", oldArtifact, "--verification-old-provenance", oldProvenance], { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  console.log(JSON.stringify({ currentProvenance: provenance, historicalProvenance: historical, installedAcceptance: JSON.parse(result.stdout) }, null, 2));
} catch (error) {
  // Child diagnostics come only from trusted local drivers; no application raw errors.
  console.error(error.stderr?.slice(-8000) ?? "Installed upgrade trial failed."); process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
