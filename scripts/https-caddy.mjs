import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * Portable resolver for the pinned Caddy HTTPS fixture. The version, URL and
 * SHA-512 mirror the "Install verified Caddy fixture" step of
 * `.github/workflows/verify.yml` (a unit test keeps them in sync); the archive
 * checksum is always verified before anything is extracted or executed.
 *
 * An explicit `CADDY_BIN` (as CI sets after its own checksum step) is used as
 * given once it reports the pinned version. Otherwise the pinned linux/x64
 * archive is downloaded with a byte and time bound into a private cache under
 * `node_modules/.cache`, installed atomically, and every later reuse re-hashes
 * the cached binary against the digest recorded at verified extraction. Other
 * platforms get a truthful error telling them to set `CADDY_BIN`.
 */

export const CADDY_VERSION = "2.11.3";

export const CADDY_ASSETS = {
  "linux-x64": {
    url: "https://github.com/caddyserver/caddy/releases/download/v2.11.3/caddy_2.11.3_linux_amd64.tar.gz",
    sha512: "ee886eceda0ff9f30610d3be9b5b594026591e19add6b3961a341c72abe468e5eac9d7c2c2450bbb8420db1f827b954521f9336be4872f81090b8618adf8815a",
  },
};

/** The real archive is ~16 MB; anything far beyond it is not the pinned release. */
export const CADDY_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const CADDY_MAX_BINARY_BYTES = 128 * 1024 * 1024;
/** A stalled transfer fails instead of holding the verification slot until the queue timeout. */
export const CADDY_DOWNLOAD_TIMEOUT_MS = 180_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export class CaddyResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaddyResolveError";
  }
}

async function defaultDownload(url, destination, maxBytes) {
  const signal = AbortSignal.timeout(CADDY_DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal });
  } catch (cause) {
    throw new CaddyResolveError(
      `Could not download the pinned Caddy ${CADDY_VERSION} archive (no network, the host blocked it, or it exceeded ` +
      `${CADDY_DOWNLOAD_TIMEOUT_MS} ms): ${cause instanceof Error ? cause.message : String(cause)}. ` +
      `Set CADDY_BIN to a local Caddy ${CADDY_VERSION} binary to run without network.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new CaddyResolveError(
      `Caddy download failed with HTTP ${response.status}. Set CADDY_BIN to a local Caddy ${CADDY_VERSION} binary instead.`,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new CaddyResolveError(`Caddy archive declares ${declared} bytes, beyond the ${maxBytes}-byte download bound; refusing to download it.`);
  }
  let received = 0;
  const source = Readable.fromWeb(response.body);
  source.on("data", chunk => {
    received += chunk.length;
    if (received > maxBytes) {
      source.destroy(new CaddyResolveError(`Caddy archive exceeded the ${maxBytes}-byte download bound; refusing to continue.`));
    }
  });
  try {
    await pipeline(source, createWriteStream(destination, { mode: 0o600 }));
  } catch (cause) {
    if (cause instanceof CaddyResolveError) throw cause;
    throw new CaddyResolveError(
      `Caddy download did not complete: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      `Set CADDY_BIN to a local Caddy ${CADDY_VERSION} binary to run without network.`,
    );
  }
}

async function defaultExtract(archive, directory) {
  // Extract exactly the one member we need; no other member or path from the archive is written.
  await execFileAsync("tar", ["-xzf", archive, "-C", directory, "--no-same-owner", "caddy"]);
}

async function defaultProbeVersion(binary) {
  const { stdout } = await execFileAsync(binary, ["version"], { timeout: VERSION_PROBE_TIMEOUT_MS });
  return stdout.trim();
}

async function sha512Of(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** A regular, non-symlink file within the size bound, or null. */
async function regularFile(path, maxBytes) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (maxBytes !== undefined && info.size > maxBytes) return null;
  return info;
}

/** The cached install is trusted only when its record matches this pin and the binary still hashes to the recorded digest. */
async function verifiedCache(cacheDirectory, asset, key) {
  const binary = join(cacheDirectory, "caddy");
  const marker = join(cacheDirectory, "pinned.json");
  if (!await regularFile(binary, CADDY_MAX_BINARY_BYTES) || !await regularFile(marker, 64 * 1024)) return null;
  let record;
  try {
    record = JSON.parse(await readFile(marker, "utf8"));
  } catch {
    return null;
  }
  if (record?.version !== CADDY_VERSION || record.platform !== key || record.url !== asset.url || record.sha512 !== asset.sha512) return null;
  if (typeof record.binarySha512 !== "string" || await sha512Of(binary) !== record.binarySha512) return null;
  return binary;
}

/**
 * Resolves a Caddy binary for the HTTPS tests. Returns `{ binary, origin }`
 * where origin is `env`, `cache` or `download`. All side effects beyond the
 * explicit `CADDY_BIN` stay inside `cacheRoot`; staging is always removed,
 * and the archive checksum is verified before extraction.
 */
export async function resolveCaddyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cacheRoot = options.cacheRoot ?? join(repositoryRoot, "node_modules", ".cache", "worktree-control", "caddy");
  const download = options.download ?? defaultDownload;
  const extract = options.extract ?? defaultExtract;
  const probeVersion = options.probeVersion ?? defaultProbeVersion;
  const key = `${platform}-${arch}`;
  const asset = options.asset ?? CADDY_ASSETS[key];

  if (env.CADDY_BIN) {
    const binary = env.CADDY_BIN;
    // An explicit choice may be a symlink (as from a package manager); it must resolve to a file.
    const info = await stat(binary).catch(() => null);
    if (!info?.isFile()) {
      throw new CaddyResolveError(`CADDY_BIN is set to ${binary}, which is not a file. Point it at the Caddy ${CADDY_VERSION} binary.`);
    }
    let reported;
    try {
      reported = await probeVersion(binary);
    } catch (cause) {
      throw new CaddyResolveError(
        `CADDY_BIN ${binary} could not report its version: ${cause instanceof Error ? cause.message : String(cause)}. Point it at the Caddy ${CADDY_VERSION} binary.`,
      );
    }
    if (!new RegExp(`^v${CADDY_VERSION.replaceAll(".", "\\.")}(\\s|$)`).test(reported)) {
      throw new CaddyResolveError(`CADDY_BIN ${binary} reports "${reported.slice(0, 120)}", not the tested Caddy v${CADDY_VERSION}.`);
    }
    return { binary, origin: "env" };
  }
  if (!asset) {
    throw new CaddyResolveError(
      `The automatic Caddy ${CADDY_VERSION} fixture supports linux x64 only; this is ${key}. ` +
      `Download Caddy ${CADDY_VERSION} for this platform and set CADDY_BIN to the binary.`,
    );
  }

  const cacheDirectory = join(cacheRoot, `${CADDY_VERSION}-${key}`);
  const cached = await verifiedCache(cacheDirectory, asset, key);
  if (cached) return { binary: cached, origin: "cache" };

  // Stage beside the final directory so the install is one atomic same-filesystem rename.
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  const staging = await mkdtemp(join(cacheRoot, ".staging-"));
  try {
    const archive = join(staging, "caddy.tar.gz");
    await download(asset.url, archive, CADDY_MAX_ARCHIVE_BYTES);
    const archiveInfo = await regularFile(archive);
    if (!archiveInfo) throw new CaddyResolveError("The Caddy download did not produce an archive file.");
    if (archiveInfo.size > CADDY_MAX_ARCHIVE_BYTES) {
      throw new CaddyResolveError(`Caddy archive exceeded the ${CADDY_MAX_ARCHIVE_BYTES}-byte bound; refusing to extract it.`);
    }
    // Verify the pinned checksum before the archive is ever extracted or run.
    const checksum = await sha512Of(archive);
    if (checksum !== asset.sha512) {
      throw new CaddyResolveError(
        `Caddy archive checksum mismatch: expected sha512 ${asset.sha512}, got ${checksum}. Refusing to extract or execute it.`,
      );
    }
    const install = join(staging, "install");
    await mkdir(install, { mode: 0o700 });
    await extract(archive, install);
    const extracted = join(install, "caddy");
    const binaryInfo = await regularFile(extracted);
    if (!binaryInfo) throw new CaddyResolveError("The Caddy archive did not contain the expected caddy binary.");
    if (binaryInfo.size > CADDY_MAX_BINARY_BYTES) {
      throw new CaddyResolveError(`The extracted Caddy binary exceeded the ${CADDY_MAX_BINARY_BYTES}-byte bound; refusing to use it.`);
    }
    await chmod(extracted, 0o700);
    const record = { version: CADDY_VERSION, platform: key, url: asset.url, sha512: asset.sha512, binarySha512: await sha512Of(extracted) };
    await writeFile(join(install, "pinned.json"), JSON.stringify(record) + "\n", { mode: 0o600 });
    await rm(cacheDirectory, { recursive: true, force: true });
    await rename(install, cacheDirectory);
    return { binary: join(cacheDirectory, "caddy"), origin: "download" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The vitest CLI entry from its package `bin`; vitest does not export the file as a module subpath. */
export function resolveVitestEntry() {
  const require = createRequire(join(repositoryRoot, "package.json"));
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (typeof bin !== "string") throw new CaddyResolveError("The installed vitest package declares no vitest binary.");
  return join(dirname(manifestPath), bin);
}
