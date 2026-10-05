"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { readStoredValue, writeStoredValue } from "@/lib/browser-storage";

import { localeFrom, type Locale, translate } from "./messages";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: typeof translate extends (locale: Locale, ...args: infer Rest) => infer Result ? (...args: Rest) => Result : never;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = readStoredValue(window.localStorage, "locale");
      const detected = saved ? localeFrom(saved) : "en";
      setLocaleState(detected);
      document.documentElement.lang = detected;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale(next) {
      setLocaleState(next);
      document.documentElement.lang = next;
      writeStoredValue(window.localStorage, "locale", next);
    },
    t: (key, values) => translate(locale, key, values),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
