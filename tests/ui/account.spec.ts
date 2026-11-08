import { expect, test } from "@playwright/test";

import { SIGN_OUT_UNCONFIRMED_KEY } from "../../src/features/account/use-account-session";
import { FIXTURE_PROJECT_ID, FIXTURE_RESERVATION_ID, mockWebAuthn, mountAccount } from "./account-fixture";

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
  expect(mutation?.body).toMatchObject({ operation: "claim", projectId: FIXTURE_PROJECT_ID, worktreePath: "/fixture/web", reason: "GUI proof", ttlSeconds: 1800 });
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

test("a failed mode probe shows a retriable error instead of the legacy dashboard", async ({ page }) => {
  const fixture = await mountAccount(page, { authStatusFails: true });
  // A probe error is not a definitive answer: neither surface renders.
  await expect(page.getByText("Could not determine the sign-in mode")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);

  fixture.authStatusFails = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
});

for (const [name, answer] of [
  ["a dropped connection", "network"],
  ["a 200 without a usable body", { json: {} }],
  ["a 200 with an unknown mode", { json: { mode: "kerberos", loginAvailable: false } }],
  ["a 200 claiming a token mode with a login surface", { json: { mode: "token", loginAvailable: true } }],
] as const) {
  test(`${name} from the mode probe never selects the legacy token dashboard`, async ({ page }) => {
    await mountAccount(page, { authStatusAnswer: answer });
    await expect(page.getByText("Could not determine the sign-in mode")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
}

test("account mode with an unavailable provider shows a retriable notice, not the legacy dashboard", async ({ page }) => {
  await mountAccount(page, { authStatusAnswer: { json: { mode: "better-auth", loginAvailable: false } } });
  await expect(page.getByText("Account sign-in is temporarily unavailable")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});

test("a failed session probe hides account data and the sign-in form until a retry answers", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, getSessionFailures: 1 });
  await expect(page.getByText("Could not check the session")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === "/api/auth/get-session")).toHaveLength(2);
});

test("sign-out retries once after a failure and then confirms", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 1 });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  // The first attempt failed with a 503; the bounded retry confirmed the sign-out.
  expect(fixture.requests.filter(request => request.path === "/api/auth/sign-out")).toHaveLength(2);
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(fixture.errors).toEqual([]);
});

test("an unconfirmed sign-out blocks the account UI until a manual retry confirms it", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  // Both bounded attempts failed: the honest unconfirmed state, never a fake sign-in screen.
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).not.toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).not.toBeNull();

  fixture.signOutFailures = 0;
  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a reload with an unconfirmed sign-out marker finishes the sign-out instead of resuming the session", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  // The session survived server-side and the marker remembers the intent: a reload
  // must complete the sign-out, never silently resume the account.
  fixture.signOutFailures = 0;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a reload whose session probe fails keeps a pending sign-out unconfirmed instead of offering sign-in", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  fixture.getSessionFailures = 1;
  await page.reload();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).not.toBeNull();

  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a fresh sign-in supersedes a stale sign-out marker from another tab instead of ending the new session", async ({ page }) => {
  const fixture = await mountAccount(page);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  // Another tab of the same origin recorded an unconfirmed sign-out meanwhile.
  await page.evaluate(key => localStorage.setItem(key, "1"), SIGN_OUT_UNCONFIRMED_KEY);

  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === "/api/auth/sign-out")).toHaveLength(0);
  expect(fixture.session).not.toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).toBeNull();
});

test("a reload that cannot confirm the sign-out stays on the unconfirmed screen until the user chooses", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 99 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);

  // An explicit user choice returns to the account and clears the intent marker.
  await page.getByRole("button", { name: "Return to account" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).toBeNull();
  fixture.signOutFailures = 0;
});

test("losing the session mid-work returns to sign-in with a session-lost notice", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  // Server-side expiry or revocation; the next read proves the session is gone.
  fixture.session = null;
  await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("The session expired or was revoked. Sign in again.")).toBeVisible();
});

test("selects an environment profile and saves a preset timeout with CAS and a re-fetch", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  await expect(page.getByText("Profile selected.")).toBeVisible();
  const select = fixture.requests.find(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "select_environment_profile");
  expect(select?.body).toMatchObject({ operation: "select_environment_profile", projectId: FIXTURE_PROJECT_ID, name: "ci", expectedRevision: 3 });

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Timeout saved.")).toBeVisible();
  const timeout = fixture.requests.find(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "set_test_preset_timeout");
  // Profile selection and timeouts share the project revision: the save after a select carries the re-read one.
  expect(timeout?.body).toMatchObject({
    operation: "set_test_preset_timeout", projectId: FIXTURE_PROJECT_ID,
    worktreePath: "/fixture/web", presetId: "node:test", timeoutMs: 120000, expectedRevision: 4,
  });

  // Both saves re-fetched the fresh state instead of trusting their own write.
  const reads = fixture.requests.filter(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "profiles");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  const configurations = fixture.requests.filter(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "configuration");
  expect(configurations.length).toBeGreaterThanOrEqual(2);
  expect(fixture.errors).toEqual([]);
});

const conflictMessage = "The configuration changed meanwhile. The current values were reloaded; review them and try again.";
const configurationBodies = (fixture: { requests: Array<{ path: string; body: unknown }> }, operation: string) =>
  fixture.requests
    .filter(request => request.path === "/api/runtime/configuration" && (request.body as { operation?: string } | null)?.operation === operation)
    .map(request => request.body as { expectedRevision?: number; idempotencyKey?: string });

test("a profile revision conflict is shown once, reloads the current values and lets a retry succeed", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, configurationConflictOnce: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  // Exactly one alert: the panel owns the message, the project section does not repeat it.
  await expect(page.getByText(conflictMessage)).toHaveCount(1);
  await expect(page.getByText("Profile selected.")).toHaveCount(0);
  // The concurrent writer's values replaced the stale draft.
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("90000");
  await expect(page.getByLabel("Environment profile")).toHaveValue("dev");

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  await expect(page.getByText("Profile selected.")).toBeVisible();
  await expect(page.getByText(conflictMessage)).toHaveCount(0);
  const selects = configurationBodies(fixture, "select_environment_profile");
  expect(selects.map(body => body.expectedRevision)).toEqual([3, 4]);
  // A retry after a reported conflict is a new intent with a new idempotency key.
  expect(new Set(selects.map(body => body.idempotencyKey)).size).toBe(2);
  expect(fixture.errors).toEqual([]);
});

test("a timeout revision conflict reloads the current override and a retry carries the fresh revision", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, configurationConflictOnce: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(conflictMessage)).toHaveCount(1);
  await expect(page.getByText("Timeout saved.")).toHaveCount(0);
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("90000");

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Timeout saved.")).toBeVisible();
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("120000");
  expect(configurationBodies(fixture, "set_test_preset_timeout").map(body => body.expectedRevision)).toEqual([3, 4]);
  expect(fixture.errors).toEqual([]);
});

test("renews an own claim from the claim controls", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Claim reason").fill("GUI proof");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByRole("button", { name: "Renew" })).toBeVisible();

  await page.getByRole("button", { name: "Renew" }).click();
  const renew = fixture.requests.find(request => request.path === "/api/runtime/mutate"
    && (request.body as { operation?: string } | null)?.operation === "renew");
  expect(renew?.body).toMatchObject({ operation: "renew", projectId: FIXTURE_PROJECT_ID, reservationId: FIXTURE_RESERVATION_ID, ttlSeconds: 1800 });
  expect(fixture.errors).toEqual([]);
});

test("cancels a queued test run", async ({ page }) => {
  const runId = "44444444-4444-4444-8444-444444444444";
  const state = { phase: "queued" };
  const envelope = (phase: string) => ({
    schemaVersion: 1, epoch: "epoch-1", cursor: "cursor-1", observedAt: "2030-01-01T00:00:00.000Z", retryAfterMs: null,
    status: {
      runId, projectId: FIXTURE_PROJECT_ID, presetId: "node:test", worktreePath: "/fixture/web", phase,
      queuedAt: "2030-01-01T00:00:00.000Z", startedAt: null, finishedAt: null, exitCode: null, errorCode: null,
      source: { queuedHead: null, preflightHead: null, finishHead: null, attribution: "pending", processOutcome: null },
    },
  });
  const fixture = await mountAccount(page, {
    preAuthenticated: true,
    runtimeTests: body => {
      if (body.operation === "presets") return { json: [{ worktreePath: "/fixture/web", presets: [{ id: "node:test", timeoutMs: 60_000 }] }] };
      if (body.operation === "enqueue") return { json: envelope(state.phase) };
      if (body.operation === "status") return { json: envelope(state.phase) };
      if (body.operation === "cancel") { state.phase = "cancelled"; return { json: envelope(state.phase) }; }
      return { status: 400, json: { code: "invalid_request", error: "Unknown fixture test operation" } };
    },
  });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled")).toBeVisible();

  const cancel = fixture.requests.find(request => request.path === "/api/runtime/tests"
    && (request.body as { operation?: string } | null)?.operation === "cancel");
  expect(cancel?.body).toMatchObject({ operation: "cancel", runId, projectId: FIXTURE_PROJECT_ID });
  expect(fixture.errors).toEqual([]);
});
