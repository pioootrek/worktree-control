import type { Page } from "@playwright/test";
import { translate, type Locale, type TranslationKey } from "../../src/i18n/messages";

export async function openPreferences(page: Page, locale: Locale = "en") {
  await page.getByRole("button", { name: translate(locale, "layout.preferences"), exact: true }).click();
}

export async function selectLanguage(page: Page, locale: Locale = "en") {
  await openPreferences(page, locale);
  await page.getByRole("menuitem", { name: translate(locale, "language.label"), exact: true }).click();
}

export async function openSystemDialog(page: Page, label: TranslationKey, locale: Locale = "en") {
  await page.getByRole("button", { name: translate(locale, "layout.system"), exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: translate(locale, label) }).click();
}
