import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Ed25519DevVaultOwnerVerifier } from "../server/modules/dev-vault";
import { runDevVaultCommand } from "./dev-vault";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("signs an exact stdin command with a separate key after validating owner identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "dev-vault-cli-")); roots.push(root);
  const path = join(root, "fake-signing-key"), pair = generateKeyPairSync("ed25519");
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const actor = { principalId: randomUUID(), credentialId: randomUUID(), principalKind: "owner" as const, authenticationMethod: "owner_session" as const };
  const command = { operation: "list", environment: "DEV", projectId: randomUUID(), operationId: randomUUID() };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ principal: { id: actor.principalId, kind: "owner" }, credential: { id: actor.credentialId, kind: "owner_session" } }))
    .mockResolvedValueOnce(Response.json({ result: { profiles: [] } }));
  const output: string[] = [];
  await runDevVaultCommand(["--endpoint", "http://127.0.0.1:3410"], { environment: { WORKTREE_CONTROL_DEV_VAULT_TOKEN: "fake-token", WORKTREE_CONTROL_DEV_VAULT_OWNER_PRIVATE_KEY_FILE: path },
    input: (async function* () { yield JSON.stringify({ command }); })(), fetch: send, write: line => output.push(line), warn: () => undefined });
  const sent = JSON.parse(send.mock.calls[1][1]!.body as string);
  expect(new Ed25519DevVaultOwnerVerifier(() => pair.publicKey).verify(sent.command, actor, sent.proof, new Date().toISOString())).toBe("valid");
  expect(send.mock.calls[1][1]!.redirect).toBe("error");
  expect(output).toHaveLength(1);
});
it.each([2000, -2000, 120_000])("signs for the controller clock when the CLI clock differs by %i ms", async offset => {
  const root = mkdtempSync(join(tmpdir(), "dev-vault-cli-")); roots.push(root);
  const path = join(root, "fake-signing-key"), pair = generateKeyPairSync("ed25519");
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const actor = { principalId: randomUUID(), credentialId: randomUUID(), principalKind: "owner" as const, authenticationMethod: "owner_session" as const };
  const command = { operation: "list", environment: "DEV", projectId: randomUUID(), operationId: randomUUID() };
  const serverNow = new Date("2026-10-27T12:00:00.999Z");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(serverNow.getTime() + offset);
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ principal: { id: actor.principalId, kind: "owner" }, credential: { id: actor.credentialId, kind: "owner_session" } },
      { headers: { Date: serverNow.toUTCString() } }))
    .mockResolvedValueOnce(Response.json({ result: { profiles: [] } }));
  await runDevVaultCommand(["--endpoint", "https://controller.example.test"], { environment: { WORKTREE_CONTROL_DEV_VAULT_TOKEN: "fake-token", WORKTREE_CONTROL_DEV_VAULT_OWNER_PRIVATE_KEY_FILE: path },
    input: (async function* () { yield JSON.stringify({ command }); })(), fetch: send, write: () => undefined, warn: () => undefined });
  const sent = JSON.parse(send.mock.calls[1][1]!.body as string);
  expect(new Ed25519DevVaultOwnerVerifier(() => pair.publicKey).verify(sent.command, actor, sent.proof, serverNow.toISOString())).toBe("valid");
});
it("does not send credentials to redirects, insecure remote endpoints, or fall back to installation tokens", async () => {
  const send = vi.fn<typeof fetch>();
  for (const endpoint of ["http://remote.example", "https://example.test/path", "https://user:pass@example.test", "https://example.test?token=fake"]) {
    await expect(runDevVaultCommand(["--endpoint", endpoint], { environment: { WORKTREE_CONTROL_DEV_VAULT_TOKEN: "fake-token" }, fetch: send, warn: () => undefined })).rejects.toThrow();
  }
  await expect(runDevVaultCommand(["--endpoint", "http://127.0.0.1:3410"], { environment: { WORKTREE_CONTROL_TOKEN: "fake-installation" }, fetch: send, warn: () => undefined })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
