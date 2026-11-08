import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * Portable resolver for the pinned Caddy HTTPS fixture. The version, URL and
 * SHA-512 mirror the "Install verified Caddy fixture" step of
 * `.github/workflows/verify.yml`; the archive checksum is always verified
 * before anything is extracted or executed. An explicit `CADDY_BIN` (as CI
 * sets) is honored untouched; otherwise the pinned linux/x64 archive is
 * downloaded once into `node_modules/.cache` and reused. Other platforms get
 * a truthful error telling them to set `CADDY_BIN`.
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

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export class CaddyResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaddyResolveError";
  }
}

async function defaultDownload(url, destination, maxBytes) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (cause) {
    throw new CaddyResolveError(
      `Could not download the pinned Caddy ${CADDY_VERSION} archive (no network or the host blocked it): ` +
      `${cause instanceof Error ? cause.message : String(cause)}. Set CADDY_BIN to a local Caddy ${CADDY_VERSION} binary to run without network.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new CaddyResolveError(
      `Caddy download failed with HTTP ${response.status}. Set CADDY_BIN to a local Caddy ${CADDY_VERSION} binary instead.`,
    );
  }
  let received = 0;
  const source = Readable.fromWeb(response.body);
  source.on("data", chunk => {
    received += chunk.length;
    if (received > maxBytes) {
      source.destroy(new CaddyResolveError(`Caddy archive exceeded the ${maxBytes}-byte download bound; refusing to continue.`));
    }
  });
  await pipeline(source, createWriteStream(destination, { mode: 0o600 }));
}

async function defaultExtract(archive, directory) {
  // Extract exactly the one member we need; no path or member from the archive is trusted.
  await execFileAsync("tar", ["-xzf", archive, "-C", directory, "caddy"]);
}

async function sha512Of(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Resolves a Caddy binary for the HTTPS tests. Returns `{ binary, origin }`
 * where origin is `env`, `cache` or `download`. All side effects beyond the
 * explicit `CADDY_BIN` stay inside `cacheRoot`; temporary files are always
 * removed, and the archive checksum is verified before extraction.
 */
export async function resolveCaddyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cacheRoot = options.cacheRoot ?? join(repositoryRoot, "node_modules", ".cache", "worktree-control", "caddy");
  const download = options.download ?? defaultDownload;
  const extract = options.extract ?? defaultExtract;
  const key = `${platform}-${arch}`;
  const asset = options.asset ?? CADDY_ASSETS[key];

  if (env.CADDY_BIN) {
    const binary = env.CADDY_BIN;
    const info = await stat(binary).catch(() => null);
    if (!info?.isFile()) {
      throw new CaddyResolveError(`CADDY_BIN is set to ${binary}, which is not a file. Point it at the Caddy ${CADDY_VERSION} binary.`);
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
  const binary = join(cacheDirectory, "caddy");
  const marker = join(cacheDirectory, "pinned.json");
  const cached = await stat(binary).catch(() => null);
  const pinned = await stat(marker).catch(() => null);
  if (cached?.isFile() && pinned?.isFile()) {
    return { binary, origin: "cache" };
  }

  // Stage inside the cache parent so the final rename stays on one filesystem and is atomic.
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(cacheRoot, ".staging-"));
  try {
    const archive = join(staging, "caddy.tar.gz");
    await download(asset.url, archive, CADDY_MAX_ARCHIVE_BYTES);
    const archiveInfo = await stat(archive);
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
    await extract(archive, staging);
    const extracted = join(staging, "caddy");
    const binaryInfo = await stat(extracted).catch(() => null);
    if (!binaryInfo?.isFile()) {
      throw new CaddyResolveError("The Caddy archive did not contain the expected caddy binary.");
    }
    if (binaryInfo.size > CADDY_MAX_BINARY_BYTES) {
      throw new CaddyResolveError(`The extracted Caddy binary exceeded the ${CADDY_MAX_BINARY_BYTES}-byte bound; refusing to use it.`);
    }
    await chmod(extracted, 0o755);
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    await rename(extracted, binary);
    await writeFile(marker, JSON.stringify({ version: CADDY_VERSION, platform: key, url: asset.url, sha512: asset.sha512 }) + "\n", { mode: 0o600 });
    return { binary, origin: "download" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
