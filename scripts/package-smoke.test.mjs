import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { packedTextContainsSecret } from "./package-smoke.mjs";

test("accepts the exact pnpm engine configuration identifier in source and serialized settings", () => {
  for (const text of [
    "pnpm_config_engine_strict",
    "env.pnpm_config_engine_strict = 'false';",
    'const env = { pnpm_config_engine_strict: "false" };',
    '{"pnpm_config_engine_strict":"false"}',
    "pnpm_config_engine_strict=false pnpm install",
    "env['pnpm_config_engine_strict']",
  ]) assert.equal(packedTextContainsSecret(text), false, "configuration identifier is not a credential");
});

// Synthetic fixtures only. Keep credential-shaped strings out of test names
// and assertion diagnostics; the scanner itself returns only a boolean.
const credentials = [
  ["npm", `npm_${"aB1".repeat(12)}`],
  ["GitHub classic", `ghp_${"aB12".repeat(10)}`],
  ["GitHub fine-grained", `github_pat_${"1aB_".repeat(20)}`],
  ["AWS access key", `AKIA${"A1".repeat(8)}`],
];
const contexts = [
  ["bare", token => token],
  ["JSON", token => JSON.stringify({ token })],
  ["environment", token => `TOKEN=${token}\n`],
  ["shell", token => `export TOKEN='${token}'; command`],
  ["JavaScript", token => `const token = "${token}";`],
  ["URL password", token => `https://user:${token}@example.invalid/`],
  ["URL query", token => `https://example.invalid/?token=${token}&mode=read`],
  ["URL path", token => `https://example.invalid/${token}/resource`],
  ["authorization header", token => `Authorization: Bearer ${token}\r\n`],
];
for (const [kind, token] of credentials) {
  for (const [context, wrap] of contexts) {
    test(`detects synthetic ${kind} credential in ${context}`, () => {
      const text = wrap(token);
      assert.equal(packedTextContainsSecret(text), true, "credential must fail the packed-text audit");
      assert.equal(packedTextContainsSecret(text), true, "repeated scans must not skip a credential");
    });
  }
}

test("keeps existing prefixed-token minimum lengths and rejects identifier substrings", () => {
  for (const prefix of ["npm", "ghp", "github_pat"]) {
    const token = `${prefix}_${"a".repeat(20)}`;
    assert.equal(packedTextContainsSecret(token), true, "minimum-length credential remains detected");
    assert.equal(packedTextContainsSecret(`${prefix}_${"a".repeat(19)}`), false, "short identifier remains accepted");
    for (const before of ["p", "0", "_", "$"]) {
      assert.equal(packedTextContainsSecret(`${before}${token}`), false, "embedded identifier is not a credential token");
    }
    assert.equal(packedTextContainsSecret(`${token}$suffix`), false, "partial identifier is not a credential token");
    assert.equal(packedTextContainsSecret(`pnpm_config_engine_strict=false\nTOKEN=${token}`), true, "configuration must not exempt an actual credential");
  }
});

test("accepts PEM parsing syntax and marker-only documentation, but retains the sentinel", () => {
  assert.equal(packedTextContainsSecret("prefix-portable-smoke-secret-must-not-leak-suffix"), true);
  for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    assert.equal(packedTextContainsSecret(`Supported input: -----BEGIN ${kind}PRIVATE KEY-----`), false);
  }
  const parser = String.raw`/^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/`;
  assert.equal(packedTextContainsSecret(parser), false);
  assert.equal(packedTextContainsSecret("ordinary package documentation"), false);
});

test("detects private-key payloads in plain text and serialized bundles, including truncated blocks", () => {
  // Ephemeral fixtures only; assertion diagnostics never include their contents.
  const ed = generateKeyPairSync("ed25519").privateKey;
  const keys = [
    ed.export({ format: "pem", type: "pkcs8" }).toString(),
    ed.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "fixture-only" }).toString(),
    generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "sec1" }).toString(),
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "sec1", cipher: "aes-256-cbc", passphrase: "fixture-only" }).toString(),
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${"YWJj".repeat(16)}\n-----END OPENSSH PRIVATE KEY-----`,
  ];
  for (const key of keys) {
    for (const value of [key, key.replaceAll("\n", "\r\n"), key.split("-----END")[0]]) {
      for (const text of [value, JSON.stringify({ key: value }), `const key = ${JSON.stringify(value)};`]) {
        assert.equal(packedTextContainsSecret(text), true, "key payload must fail the packed-text audit");
      }
    }
  }
});

test("scanner imports from the delivered smoke and installer pair without running the smoke", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wtc-smoke-scanner-"));
  try {
    for (const name of ["package-smoke.mjs", "package-install.mjs"]) {
      await copyFile(new URL(name, import.meta.url), join(directory, name));
    }
    const { packedTextContainsSecret: standaloneScan } = await import(pathToFileURL(join(directory, "package-smoke.mjs")));
    assert.equal(standaloneScan("pnpm_config_engine_strict"), false);
    assert.equal(standaloneScan(credentials[0][1]), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
