import { createPrivateKey, sign } from "node:crypto";
import { DEV_VAULT_DISCLAIMER, devVaultRequestSchema, type DevOwnerProof } from "../shared/contracts/dev-vault";
import { devOwnerSigningMessage } from "../server/modules/dev-vault";
import { readExternalVaultFile } from "../server/infrastructure/dev-vault";

export interface DevVaultCliDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  input?: AsyncIterable<string | Buffer>;
  fetch?: typeof fetch;
  write?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Online-only: CLI/TTY/filesystem presence never establishes owner authority. JSON is read from stdin. */
export async function runDevVaultCommand(args: string[], dependencies: DevVaultCliDependencies = {}): Promise<void> {
  const fail = (): never => { throw new Error("DEV vault request failed. See docs/dev-environment-vault.md; no request values are included in this error."); };
  const environment = dependencies.environment ?? process.env;
  const write = dependencies.write ?? (line => process.stdout.write(`${line}\n`));
  (dependencies.warn ?? (line => process.stderr.write(`${line}\n`)))(DEV_VAULT_DISCLAIMER);
  if (args.length !== 2 || args[0] !== "--endpoint") throw new Error("Usage: vault --endpoint URL < request.json (DEV only)");
  let endpoint: URL;
  try {
    endpoint = new URL(args[1]);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
      || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)))) return fail();
  } catch { return fail(); }
  const token = environment.WORKTREE_CONTROL_DEV_VAULT_TOKEN;
  if (!token) return fail();
  const send = dependencies.fetch ?? fetch;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of dependencies.input ?? process.stdin) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > 96 * 1024) return fail();
      chunks.push(buffer);
    }
    const parsed = devVaultRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) return fail();
    const body = parsed.data;
    const privatePath = environment.WORKTREE_CONTROL_DEV_VAULT_OWNER_PRIVATE_KEY_FILE;
    if (privatePath) {
      const identityResponse = await send(new URL("/api/identity", endpoint), { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!identityResponse.ok) return fail();
      const identity = await identityResponse.json() as { principal: { id: string; kind: string }; credential: { id: string; kind: string } | null };
      if (identity.principal.kind !== "owner" || identity.credential?.kind !== "owner_session") return fail();
      const key = createPrivateKey(readExternalVaultFile(privatePath, [], true, 8192));
      if (key.asymmetricKeyType !== "ed25519") return fail();
      // This proof is sent immediately. Use the controller's whole-second lower
      // bound, with the same one-second backdating as the browser signing flow.
      const serverTime = Date.parse(identityResponse.headers.get("date") ?? "");
      const issuedAt = new Date((Number.isFinite(serverTime) ? serverTime : Date.now()) - 1000).toISOString();
      const proof: DevOwnerProof = { issuedAt, signature: sign(null, devOwnerSigningMessage(body.command,
        { principalId: identity.principal.id, credentialId: identity.credential.id }, issuedAt), key).toString("base64") };
      body.proof = proof;
    }
    const response = await send(new URL("/api/dev-vault", endpoint), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return fail();
    write(JSON.stringify(await response.json(), null, 2));
  } catch { return fail(); }
}
