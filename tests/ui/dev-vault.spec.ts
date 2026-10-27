import { generateKeyPairSync } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { FAKE_DOTENV, vaultFixture } from "../../src/server/modules/dev-vault/test-fixture";
import { devVaultFailure, executeDevVault } from "../../src/server/transports/dev-vault";
import { DevVaultOperations } from "../../src/server/modules/dev-vault";
import { ProjectLifecycle } from "../../src/server/modules/lifecycle";
import { ProcessManager } from "../../src/server/process-manager";
import type { AuthenticatedPrincipal } from "../../src/server/modules/identity";
import { translate } from "../../src/i18n/messages";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

/** Fake fixture values only; the controller service, SQLite state and Ed25519 verifier are real. */
const FAKE_VALUE = FAKE_DOTENV.split("=")[1];
const PATCH_VALUE = "FAKE_DEV_PATCH_VALUE_123";
const ORIGIN = "http://127.0.0.1:3410";
let fixture: ReturnType<typeof vaultFixture> | null = null;
test.afterEach(() => { fixture?.close(); fixture = null; });

async function mount(page: Page, origin = ORIGIN) {
  const f = fixture = vaultFixture();
  const vault = new DevVaultOperations(f.vault, new ProjectLifecycle(f.store, new ProcessManager()));
  // The browser signs with its own clock; align it with the fixture controller clock.
  await page.clock.setFixedTime(new Date(f.now));
  const data = dashboardFixture();
  data.projects[0].project.id = f.project.id;
  const shell = await mountDashboard(page, data, { origin });
  let expireNextProof = false;
  const calls: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
  const json = (status: number, body: unknown) => ({ status, json: body, headers: { Date: new Date(f.now).toUTCString(), "Cache-Control": "no-store" } });
  await page.route(/\/api\/(dev-vault|identity(\/admin)?)$/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ?? "";
    calls.push({ path, headers: request.headers(), body });
    let actor: AuthenticatedPrincipal;
    try { actor = f.identity.authenticateBearer((request.headers().authorization ?? "").replace(/^Bearer /, "")); }
    catch { return route.fulfill(json(401, { error: "fixture invalid credential" })); }
    if (path === "/api/identity") return route.fulfill(json(200, f.identity.describeIdentity(actor)));
    if (path === "/api/identity/admin") {
      try { return route.fulfill(json(200, { credentials: f.identity.listAgentCredentials(JSON.parse(body).principalId, actor) })); }
      catch { return route.fulfill(json(403, { error: "fixture forbidden" })); }
    }
    if (expireNextProof && JSON.parse(body).command.operation === "list") {
      expireNextProof = false; f.advance(61_000);
      await page.clock.setFixedTime(new Date(f.now));
    }
    try { return route.fulfill(json(200, await executeDevVault(vault, JSON.parse(body), actor))); }
    catch (error) { const failure = devVaultFailure(error); return route.fulfill(json(failure.status, failure.body)); }
  });
  const pem = f.pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { f, calls, pem, errors: shell.errors, expireNextProof: () => { expireNextProof = true; } };
}

async function openVault(page: Page, locale: "en" | "pl" = "en") {
  await page.getByRole("button", { name: translate(locale, "dashboard.navVault"), exact: true }).click();
  await expect(page.getByRole("heading", { name: translate(locale, "vault.title") })).toBeVisible();
}

async function unlock(page: Page, token: string, pem: string) {
  await page.getByLabel(translate("en", "vault.ownerToken")).fill(token);
  await page.getByLabel(translate("en", "vault.ownerKey")).setInputFiles({ name: "owner-fixture.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(pem) });
  await page.getByRole("button", { name: translate("en", "vault.connect"), exact: true }).click();
}

async function persistedBrowserState(page: Page) {
  return page.evaluate(async () => {
    const storage = (store: Storage) => Array.from({ length: store.length }, (_, index) => `${store.key(index)}=${store.getItem(store.key(index)!)}`).join("\n");
    return {
      local: storage(localStorage), session: storage(sessionStorage),
      databases: (await indexedDB.databases()).map(database => database.name),
      caches: await caches.keys(),
    };
  });
}

test("insecure origins show signing as unavailable instead of an unprotected form", async ({ page }) => {
  await mount(page, "http://switcher.test");
  await openVault(page);
  await expect(page.getByText(translate("en", "vault.signingUnavailableTitle"))).toBeVisible();
  await expect(page.getByLabel(translate("en", "vault.ownerKey"))).toHaveCount(0);
  await expect(page.getByText(translate("en", "vault.disclaimerTitle"), { exact: true })).toBeVisible();
});

test("owner unlock rejects agent tokens, signs every command and persists no secret material", async ({ page }) => {
  const { f, calls, pem, errors } = await mount(page);
  await openVault(page);
  await expect(page.getByText(translate("en", "vault.disclaimer"))).toBeVisible();
  await expect(page.getByText(translate("en", "vault.useUnavailable")).first()).toBeVisible();
  await unlock(page, f.first.token, pem);
  const vault = page.locator("[data-dev-vault]");
  await expect(vault.getByRole("alert")).toContainText(translate("en", "vault.error.not_owner_session"));
  await expect(page.getByLabel(translate("en", "vault.ownerKey"))).toHaveValue("");

  await unlock(page, f.ownerToken, pem);
  const profile = page.locator(`[data-vault-profile="${f.imported.profileId}"]`);
  await expect(profile).toContainText(f.imported.profileId);
  await expect(page.locator("body")).not.toContainText(FAKE_VALUE);
  const state = await persistedBrowserState(page);
  for (const value of [state.local, state.session]) {
    expect(value).not.toContain(f.ownerToken);
    expect(value).not.toContain("PRIVATE KEY");
  }
  expect(state.databases).toEqual([]);
  expect(state.caches).toEqual([]);

  const vaultCalls = calls.filter(call => call.path === "/api/dev-vault");
  expect(vaultCalls.length).toBeGreaterThanOrEqual(2);
  for (const call of calls) {
    expect(call.body).not.toContain("PRIVATE KEY");
    expect(call.headers["x-worktree-control-token"]).toBeUndefined();
  }
  for (const call of vaultCalls) {
    const body = JSON.parse(call.body);
    expect(call.headers.authorization).toBe(`Bearer ${f.ownerToken}`);
    expect(body.proof.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(body.command.environment).toBe("DEV");
  }

  await page.getByRole("button", { name: translate("en", "vault.lock") }).click();
  await expect(page.getByText(translate("en", "vault.lockedManual"))).toBeVisible();
  await expect(page.getByLabel(translate("en", "vault.ownerToken"))).toHaveValue("");
  expect(errors).toEqual([]);
});

test("a key that does not match the controller verifier is denied without exposing anything", async ({ page }) => {
  const { f } = await mount(page);
  await openVault(page);
  await unlock(page, f.ownerToken, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  await expect(page.locator("[data-dev-vault]").getByRole("alert")).toContainText(translate("en", "vault.error.vault_denied"));
  await expect(page.locator("[data-vault-profile]")).toHaveCount(0);
});

test("expired refresh proof keeps signing unlocked and retries without reconnecting", async ({ page }) => {
  const { f, pem, calls, expireNextProof, errors } = await mount(page);
  await openVault(page);
  await unlock(page, f.ownerToken, pem);
  await expect(page.locator("[data-vault-profile]")).toHaveCount(1);
  const offset = calls.length;
  expireNextProof();
  await page.getByRole("button", { name: translate("en", "vault.refresh") }).click();
  await expect(page.locator("[data-dev-vault]").getByRole("alert")).toContainText(translate("en", "vault.error.vault_proof_expired"));
  await expect(page.getByRole("button", { name: translate("en", "vault.reconnect"), exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: translate("en", "vault.refresh") }).click();
  await expect(page.locator("[data-dev-vault]").getByRole("alert")).toHaveCount(0);
  await expect(page.locator("[data-vault-profile]")).toHaveCount(1);
  const lists = calls.slice(offset).filter(call => call.path === "/api/dev-vault").map(call => JSON.parse(call.body)).filter(body => body.command.operation === "list");
  expect(lists).toHaveLength(2);
  expect(lists[0].command.operationId).toBe(lists[1].command.operationId);
  expect(lists[0].proof.issuedAt).not.toBe(lists[1].proof.issuedAt);
  expect(errors).toEqual([]);
});

test("import, explicit reveal, write inspection and approval, rejection, stale revision and revocation", async ({ page }) => {
  const { f, pem, errors } = await mount(page);
  const write = f.request("write", { dotenv: `FAKE_DEV_PATCH_NAME=${PATCH_VALUE}`, source: "inline-dotenv" });
  const read = f.request("read");
  const later = f.request("read", {}, f.second.actor);
  await openVault(page);
  await unlock(page, f.ownerToken, pem);

  // Import requires the DEV confirmation and never echoes the imported value afterwards.
  await page.getByRole("button", { name: translate("en", "vault.import") }).click();
  const importDialog = page.getByRole("dialog");
  await importDialog.getByLabel(translate("en", "vault.importText")).fill("FAKE_GUI_NAME=FAKE_GUI_VALUE_42");
  await importDialog.getByRole("button", { name: translate("en", "vault.importSubmit") }).click();
  await expect(importDialog.getByRole("alert")).toContainText(translate("en", "vault.importConfirmRequired"));
  await importDialog.getByRole("checkbox").check();
  await importDialog.getByRole("button", { name: translate("en", "vault.importSubmit") }).click();
  await expect(importDialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Imported profile" })).toBeVisible();
  await expect(page.locator("[data-vault-profile]")).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText("FAKE_GUI_VALUE_42");

  // Reveal is explicit, signed and clearable.
  const profile = page.locator(`[data-vault-profile="${f.imported.profileId}"]`);
  await profile.getByRole("button", { name: translate("en", "vault.revealValues") }).click();
  await page.getByRole("dialog").getByRole("button", { name: translate("en", "vault.revealConfirm") }).click();
  await expect(profile.locator("[data-vault-values]")).toContainText(FAKE_VALUE);
  await expect(profile.getByRole("button", { name: translate("en", "vault.hideValues") })).toBeFocused();
  await profile.getByRole("button", { name: translate("en", "vault.hideValues") }).click();
  await expect(page.locator("body")).not.toContainText(FAKE_VALUE);

  // The write patch is hidden in the list; approval requires a signed inspection first.
  const writeRow = page.locator(`[data-vault-request="${write.id}"]`);
  await expect(writeRow).toContainText(f.first.actor.credentialId);
  await expect(writeRow).toContainText("Fake fixture token");
  await expect(page.locator("body")).not.toContainText(PATCH_VALUE);
  await writeRow.getByRole("button", { name: translate("en", "vault.review") }).click();
  const approve = page.getByRole("dialog");
  const confirm = approve.getByRole("button", { name: /^Sign: approve/ });
  await expect(confirm).toBeDisabled();
  await approve.getByRole("button", { name: translate("en", "vault.inspect") }).click();
  await expect(approve.locator("[data-vault-proposal]")).toContainText(PATCH_VALUE);
  await approve.getByRole("radio", { name: new RegExp(translate("en", "vault.lifetime.15-minutes")) }).focus();
  await page.keyboard.press("Space");
  await expect(approve.getByText(translate("en", "vault.lifetimeEffect.write.15-minutes", { revision: 1 }))).toBeVisible();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(approve).toHaveCount(0);
  await expect(page.locator("[data-vault-grant]")).toHaveCount(1);

  // Rejection removes the row; focus falls back to a stable heading.
  await page.locator(`[data-vault-request="${read.id}"]`).getByRole("button", { name: translate("en", "vault.reject") }).click();
  await page.getByRole("dialog").getByRole("button", { name: translate("en", "vault.rejectConfirm") }).click();
  await expect(page.locator(`[data-vault-request="${read.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: translate("en", "vault.projectHeading") })).toBeFocused();

  // The agent applies its patch; the remaining read request is now stale and cannot be approved.
  const grantId = await page.locator("[data-vault-grant]").getAttribute("data-vault-grant");
  f.execute({ operation: "write", grantId }, f.first.actor);
  await page.getByRole("button", { name: translate("en", "vault.refresh") }).click();
  const laterRow = page.locator(`[data-vault-request="${later.id}"]`);
  await expect(laterRow).toContainText(translate("en", "vault.requestState.stale"));
  await expect(laterRow.getByRole("button", { name: translate("en", "vault.review") })).toBeDisabled();
  await expect(laterRow).toContainText(translate("en", "vault.requestReason.stale"));
  await expect(page.locator("[data-vault-grant]")).toContainText(translate("en", "vault.grantState.stale"));

  await page.locator("[data-vault-grant]").getByRole("button", { name: translate("en", "vault.revoke") }).click();
  await page.getByRole("dialog").getByRole("button", { name: translate("en", "vault.revokeConfirm") }).click();
  await expect(page.locator("[data-vault-grant]")).toHaveCount(0);
  expect(() => f.execute({ operation: "write", grantId }, f.first.actor)).toThrow("vault_denied");

  // Notices and audit events carry IDs only.
  await page.getByRole("button", { name: translate("en", "vault.auditLoad") }).click();
  await expect(page.getByRole("heading", { name: translate("en", "vault.audit") })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(FAKE_VALUE);
  await expect(page.locator("body")).not.toContainText("FAKE_GUI_VALUE_42");
  await expect(page.locator("body")).not.toContainText(PATCH_VALUE);
  expect(errors).toEqual([]);
});

test("a use approval is labelled as saved but not delivered, and an expired request cannot be approved", async ({ page }) => {
  const { f, pem } = await mount(page);
  const use = f.request("use", { binding: { commit: "a".repeat(40), presetId: "node:test", commandDigest: "b".repeat(64), workerId: "00000000-0000-4000-8000-0000000000aa" } });
  await openVault(page);
  await unlock(page, f.ownerToken, pem);
  const row = page.locator(`[data-vault-request="${use.id}"]`);
  await expect(row).toContainText("a".repeat(40));
  await row.getByRole("button", { name: translate("en", "vault.review") }).click();
  await expect(page.getByRole("dialog")).toContainText(translate("en", "vault.useUnavailable"));
  // While the dialog is open the request expires at the controller; the approval fails safely.
  f.advance(16 * 60_000);
  await page.clock.setFixedTime(new Date(f.now));
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Sign: approve/ });
  // The display clock may already mark it expired (approval disabled); otherwise the controller denies it.
  if (await confirm.isEnabled()) {
    await confirm.click();
    await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText(translate("en", "vault.error.vault_denied"));
  } else {
    await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText(translate("en", "vault.requestReason.expired"));
  }
  expect(() => f.execute({ operation: "use", ...f.imported, grantId: "00000000-0000-4000-8000-0000000000ff", binding: (use as unknown as { binding: unknown }).binding }, f.first.actor)).toThrow("vault_denied");
  await page.getByRole("dialog").getByRole("button", { name: translate("en", "common.cancel") }).click();
  await page.getByRole("button", { name: translate("en", "vault.refresh") }).click();
  await expect(row).toHaveCount(0);
});

test("Polish labels for the vault and its DEV-only disclaimer", async ({ page }) => {
  await mount(page);
  await selectLanguage(page);
  await openVault(page, "pl");
  await expect(page.getByText(translate("pl", "vault.disclaimerTitle"), { exact: true })).toBeVisible();
  await expect(page.getByLabel(translate("pl", "vault.ownerToken"))).toBeVisible();
  await expect(page.getByRole("button", { name: translate("pl", "vault.connect"), exact: true })).toBeVisible();
});
