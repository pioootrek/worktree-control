import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
export const HISTORICAL_COMMIT = "a727fd8ff01e141c6494615531e27e72a23f6320";
/** Explicit trusted local artifacts only; provenance is operator input, not authentication. */
export async function verifyHistoricalArtifact(tarball, provenancePath) {
  if (!tarball || !provenancePath) throw new Error("Explicit historical tarball and provenance are required.");
  const [archive, record] = await Promise.all([lstat(tarball), lstat(provenancePath)]);
  if (!archive.isFile() || archive.size > 16 * 1024 * 1024 || !record.isFile() || record.size > 32 * 1024) throw new Error("Historical artifact inputs exceed their regular-file bounds.");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  if (provenance.schemaVersion !== 1 || provenance.source?.commit !== HISTORICAL_COMMIT || provenance.source?.dirty !== false
    // Historical artifacts were packed before the rename, so their package name stays `worktree-switcher`.
    || provenance.package?.name !== "worktree-switcher" || provenance.package?.version !== "0.1.0-trial.1" || provenance.package?.private !== true
    || provenance.artifact?.filename !== basename(tarball) || provenance.artifact?.sha256 !== sha256 || provenance.artifact?.bytes !== archive.size)
    throw new Error("Historical artifact checksum or exact-source provenance mismatch.");
  return { source: provenance.source, artifact: provenance.artifact, build: provenance.build };
}
/** The published npm release that installed upgrades start from. Registry metadata
 * (2026-11-08) names its integrity; release commit c5c4eee carries schema 28. */
export const PUBLIC_BASELINE = Object.freeze({
  name: "worktree-control", version: "0.1.1", bytes: 906781, schema: 28,
  sha256: "f6ddd1216a285d083055c15cafc117a7d2a621c5c0414491596180f152cb5c48",
  integrity: "sha512-+e66ZAHyuAM6284tHw9JLeNx9OsdepUGeBGhPKwxMBSfEQIDUQwfUCBKkoW+cbBRoJdEATjtyzELqEsB3J+GEg==",
  sourceCommit: "c5c4eee232cbd225bd3c84d8c0c9c265a31ec851",
});
/** A registry download is untrusted until both pinned digests match. */
export async function verifyPublicBaseline(tarball) {
  const archive = await lstat(tarball);
  if (!archive.isFile() || archive.size !== PUBLIC_BASELINE.bytes) throw new Error("Public baseline size mismatch.");
  const bytes = await readFile(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (createHash("sha256").update(bytes).digest("hex") !== PUBLIC_BASELINE.sha256 || integrity !== PUBLIC_BASELINE.integrity) throw new Error("Public baseline checksum mismatch.");
  return { ...PUBLIC_BASELINE, filename: basename(tarball) };
}
/** Check every executable companion before starting a checkout-free smoke. */
export async function verifyTrialFiles(directory, provenance) {
  const entries = [[provenance.artifact.filename, provenance.artifact.sha256], [provenance.files.smoke, provenance.files.smokeSha256], [provenance.files.installer, provenance.files.installerSha256], [provenance.files.lifecycle, provenance.files.lifecycleSha256]];
  for (const [file, hash] of entries) {
    if (typeof file !== "string" || basename(file) !== file || !/^[a-f0-9]{64}$/.test(hash) || createHash("sha256").update(await readFile(`${directory}/${file}`)).digest("hex") !== hash) throw new Error("Trial executable companion checksum mismatch.");
  }
  if ((await readFile(`${directory}/SHA256SUMS`, "utf8")).trim() !== entries.map(([file, hash]) => `${hash}  ${file}`).join("\n")) throw new Error("Trial checksum manifest disagrees with provenance.");
}
