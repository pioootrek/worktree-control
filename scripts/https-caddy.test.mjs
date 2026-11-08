import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { CADDY_MAX_ARCHIVE_BYTES, CADDY_VERSION, resolveCaddyBinary } from "./https-caddy.mjs";

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

    const resolved = await resolveCaddyBinary({ env: { CADDY_BIN: binary }, download: failingDownload });
    assert.deepEqual(resolved, { binary, origin: "env" });
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
  });
});
