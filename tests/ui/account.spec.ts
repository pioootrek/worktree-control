import { expect, test } from "@playwright/test";

import { mockWebAuthn, mountAccount } from "./account-fixture";

test("rejects a wrong password and signs in with the right one without storing any credential", async ({ page }) => {
  const fixture = await mountAccount(page);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();

  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Sign-in failed. Check the credentials and try again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  await expect(page.getByText("Claim: none")).toBeVisible();

  // The cookie is the sole authority: no token or secret is stored or sent as a header.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  const apiRequests = fixture.requests.filter(request => request.path !== "/api/auth/status");
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(apiRequests.every(request => request.authorization === null)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("completes the TOTP challenge after a password sign-in", async ({ page }) => {
  await mountAccount(page, { totpCode: "123456" });
  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verification code" })).toBeVisible();

  await page.getByLabel("TOTP code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
});

test("signs in with a passkey through the platform credential API", async ({ page }) => {
  await mockWebAuthn(page);
  await mountAccount(page, { passkey: true });
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
});

test("resumes a live session after a reload and drops to sign-in when it is gone", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  // Simulate server-side expiry or revocation; the next read must return to sign-in.
  fixture.session = null;
  await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
});

test("sign-out ends the session and leaves no stale project data", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).toBeNull();
  expect(fixture.requests.some(request => request.path === "/api/auth/sign-out")).toBe(true);
});

test("knowledge reads ride the session cookie and never send a bearer", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("tab", { name: "Knowledge" }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  const knowledgeRequests = fixture.requests.filter(request => request.path === "/api/knowledge");
  expect(knowledgeRequests.length).toBeGreaterThan(0);
  expect(knowledgeRequests.every(request => request.authorization === null)).toBe(true);
});

test("claims a worktree with one idempotent mutation", async ({ page }) => {
  const fixture = await mountAccount(page, {
    preAuthenticated: true,
    runtimeMutate: () => ({
      json: {
        operation: "claim", projectId: "web",
        claim: { reservationId: "res-1", worktreePath: "/fixture/web", expiresAt: "2030-01-01T00:30:00.000Z", maximumExpiresAt: null },
        startRequested: false, error: null, replayed: false,
      },
    }),
  });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  await page.getByLabel("Claim reason").fill("GUI proof");
  await page.getByRole("button", { name: "Claim", exact: true }).click();

  const mutation = fixture.requests.find(request => request.path === "/api/runtime/mutate");
  expect(mutation?.body).toMatchObject({ operation: "claim", projectId: "web", worktreePath: "/fixture/web", reason: "GUI proof", ttlSeconds: 1800 });
  expect(String((mutation?.body as { idempotencyKey?: string })?.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.errors).toEqual([]);
});

test("shows a current-authority denial instead of reinterpreting it", async ({ page }) => {
  await mountAccount(page, {
    preAuthenticated: true,
    runtimeRead: () => ({ status: 403, json: { code: "project_access_denied", error: "Denied" } }),
  });
  await expect(page.getByText("This operation is not allowed for the account.")).toBeVisible();
  // A 403 is a denial, not session loss: the sign-in screen must not appear.
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});

test("enrolling TOTP ends the session and returns to sign-in with a notice", async ({ page }) => {
  await mountAccount(page, { preAuthenticated: true, totpCode: "123456" });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByLabel("Confirm with password").fill("fixture-password");
  await page.getByRole("button", { name: "Enable TOTP" }).click();
  await expect(page.getByLabel("Authenticator app URI")).toHaveValue(/otpauth:\/\/totp\//);
  await page.getByLabel("TOTP code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("TOTP was enabled. Sign in again.")).toBeVisible();
});

test("registers a passkey in two steps and returns to sign-in", async ({ page }) => {
  await mockWebAuthn(page);
  await mountAccount(page, { preAuthenticated: true, passkey: true });
  await page.getByRole("tab", { name: "Security" }).click();

  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByText("Passkey created. Confirm it to finish registration.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm passkey" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("The passkey was registered. Sign in again.")).toBeVisible();
});

test("open and token modes keep the legacy dashboard untouched", async ({ page }) => {
  await mountAccount(page, { loginAvailable: false });
  // The legacy surface asks for the installation token; no account form renders.
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});
