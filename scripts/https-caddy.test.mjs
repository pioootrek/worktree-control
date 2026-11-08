import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileURLToPath } from "node:url";

import { CADDY_ASSETS, CADDY_MAX_ARCHIVE_BYTES, CADDY_VERSION, resolveCaddyBinary, resolveVitestEntry } from "./https-caddy.mjs";

const execFileAsync = promisify(execFile);

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "https-caddy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeAsset(t, members = { caddy: "#!/bin/sh\necho caddy\n" }) {
  const root = await directory(t);
  for (const [name, content] of Object.entries(members)) {
    await writeFile(join(root, name), content, { mode: 0o755 });
  }
  const archive = join(root, "archive.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", root, ...Object.keys(members)]);
  const bytes = await readFile(archive);
  return {
    bytes,
    asset: { url: "https://fixture.invalid/caddy.tar.gz", sha512: createHash("sha512").update(bytes).digest("hex") },
  };
}

const failingDownload = async () => {
  throw new Error("download must not run in this test");
};

describe("resolveCaddyBinary", () => {
  it("honors an explicit CADDY_BIN without downloading", async t => {
    const root = await directory(t);
    const binary = join(root, "caddy");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });

    const resolved = await resolveCaddyBinary({
      env: { CADDY_BIN: binary }, download: failingDownload,
      probeVersion: async () => `v${CADDY_VERSION} h1:fixture=`,
    });
    assert.deepEqual(resolved, { binary, origin: "env" });
  });

  it("rejects an explicit CADDY_BIN that is not the tested version", async t => {
    const root = await directory(t);
    const binary = join(root, "caddy");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });

    for (const reported of ["v2.11.30 h1:x=", "v2.10.0 h1:x=", "caddy"]) {
      await assert.rejects(
        resolveCaddyBinary({ env: { CADDY_BIN: binary }, download: failingDownload, probeVersion: async () => reported }),
        /not the tested Caddy v2\.11\.3/,
      );
    }
    await assert.rejects(
      resolveCaddyBinary({ env: { CADDY_BIN: binary }, download: failingDownload, probeVersion: async () => { throw new Error("exec failed"); } }),
      /could not report its version/,
    );
  });

  it("rejects a CADDY_BIN that does not exist", async () => {
    await assert.rejects(
      resolveCaddyBinary({ env: { CADDY_BIN: "/definitely/missing/caddy" }, download: failingDownload }),
      /not a file/,
    );
  });

  it("tells the truth on unsupported platforms", async () => {
    await assert.rejects(
      resolveCaddyBinary({ env: {}, platform: "darwin", arch: "arm64", download: failingDownload }),
      new RegExp(`supports linux x64 only.*darwin-arm64.*CADDY_BIN`, "s"),
    );
  });

  it("verifies the checksum before extracting anything", async t => {
    const { bytes } = await fakeAsset(t);
    const cacheRoot = await directory(t);
    let extracted = false;

    await assert.rejects(
      resolveCaddyBinary({
        env: {},
        cacheRoot,
        asset: { url: "https://fixture.invalid/caddy.tar.gz", sha512: "0".repeat(128) },
        download: async (url, destination) => writeFile(destination, bytes),
        extract: async () => { extracted = true; },
      }),
      /checksum mismatch/,
    );
    assert.equal(extracted, false, "a failed checksum must stop the run before extraction");
    const leftovers = await readdir(cacheRoot).catch(() => []);
    assert.deepEqual(leftovers, [], "staging is cleaned up after a failed checksum");
  });

  it("refuses archives beyond the download bound", async t => {
    const cacheRoot = await directory(t);

    await assert.rejects(
      resolveCaddyBinary({
        env: {},
        cacheRoot,
        asset: { url: "https://fixture.invalid/caddy.tar.gz", sha512: "0".repeat(128) },
        download: async (url, destination) => writeFile(destination, Buffer.alloc(CADDY_MAX_ARCHIVE_BYTES + 1)),
      }),
      /byte bound/,
    );
  });

  it("extracts only the caddy member, caches it, and reuses the cache", async t => {
    const { bytes, asset } = await fakeAsset(t, { caddy: "#!/bin/sh\necho caddy\n", "extra-member": "not extracted" });
    const cacheRoot = await directory(t);
    let downloads = 0;

    const first = await resolveCaddyBinary({
      env: {},
      cacheRoot,
      asset,
      download: async (url, destination) => { downloads += 1; await writeFile(destination, bytes); },
    });
    assert.equal(first.origin, "download");
    assert.equal(downloads, 1);
    assert.ok((await stat(first.binary)).isFile());
    await assert.rejects(stat(join(cacheRoot, `${CADDY_VERSION}-linux-x64`, "extra-member")), /ENOENT/);
    const staging = (await readdir(cacheRoot)).filter(name => name.startsWith(".staging-"));
    assert.deepEqual(staging, [], "staging is cleaned up after a successful resolve");

    const second = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download: failingDownload });
    assert.deepEqual(second, { binary: first.binary, origin: "cache" });
    assert.equal((await stat(cacheRoot)).mode & 0o077, 0, "the cache root is private");
    assert.equal((await stat(first.binary)).mode & 0o077, 0, "the cached binary is private");
  });

  it("re-verifies the cached binary and replaces a tampered or symlinked one", async t => {
    const { bytes, asset } = await fakeAsset(t);
    const cacheRoot = await directory(t);
    let downloads = 0;
    const download = async (url, destination) => { downloads += 1; await writeFile(destination, bytes); };

    const first = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download });
    await writeFile(first.binary, "#!/bin/sh\necho tampered\n", { mode: 0o700 });
    const repaired = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download });
    assert.equal(repaired.origin, "download", "a binary that no longer matches its recorded digest is not reused");
    assert.equal(await readFile(repaired.binary, "utf8"), "#!/bin/sh\necho caddy\n");

    const elsewhere = join(await directory(t), "caddy");
    await writeFile(elsewhere, "#!/bin/sh\necho caddy\n", { mode: 0o700 });
    await rm(repaired.binary);
    await symlink(elsewhere, repaired.binary);
    const replaced = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download });
    assert.equal(replaced.origin, "download", "a symlinked cache entry is never trusted");
    assert.equal(downloads, 3);
  });

  it("does not trust a cache recorded for a different pin", async t => {
    const { bytes, asset } = await fakeAsset(t);
    const cacheRoot = await directory(t);
    let downloads = 0;
    const download = async (url, destination) => { downloads += 1; await writeFile(destination, bytes); };

    const first = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download });
    const marker = join(cacheRoot, `${CADDY_VERSION}-linux-x64`, "pinned.json");
    const record = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...record, sha512: "0".repeat(128) }));
    const second = await resolveCaddyBinary({ env: {}, cacheRoot, asset, download });
    assert.equal(second.origin, "download");
    assert.equal(second.binary, first.binary);
    assert.equal(downloads, 2);
  });

  it("leaves no partial install when extraction yields no binary", async t => {
    const { bytes, asset } = await fakeAsset(t, { "not-caddy": "x" });
    const cacheRoot = await directory(t);

    await assert.rejects(
      resolveCaddyBinary({ env: {}, cacheRoot, asset, download: async (url, destination) => writeFile(destination, bytes), extract: async () => undefined }),
      /did not contain the expected caddy binary/,
    );
    assert.deepEqual(await readdir(cacheRoot), [], "neither staging nor a half-built cache directory remains");
  });
});

describe("pinned sources", () => {
  it("mirror the CI Caddy pin in verify.yml", async () => {
    const workflow = await readFile(fileURLToPath(new URL("../.github/workflows/verify.yml", import.meta.url)), "utf8");
    const asset = CADDY_ASSETS["linux-x64"];
    assert.ok(workflow.includes(asset.url), "verify.yml downloads the same archive URL");
    assert.ok(workflow.includes(`${asset.sha512}  `), "verify.yml checks the same SHA-512");
    assert.ok(asset.url.includes(`/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz`));
  });

  it("resolve the vitest CLI entry the HTTPS runner spawns", async () => {
    const entry = resolveVitestEntry();
    assert.ok((await stat(entry)).isFile(), `${entry} exists`);
    assert.match(entry, /vitest\.mjs$/);
  });
});
