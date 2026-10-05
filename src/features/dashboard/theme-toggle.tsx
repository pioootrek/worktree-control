"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { readStoredValue, writeStoredValue } from "@/lib/browser-storage";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function useTheme() {
  const [dark, setDark] = useState(true);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    writeStoredValue(localStorage, "theme", next ? "dark" : "light");
  };
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = readStoredValue(localStorage, "theme");
      const next = saved !== "light";
      document.documentElement.classList.toggle("dark", next);
      setDark(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return { dark, toggle };
}

export function ThemeToggle() {
  const { t } = useI18n();
  const { dark, toggle } = useTheme();
  return <Button variant="outline" size="icon" onClick={toggle} aria-label={dark ? t("theme.light") : t("theme.dark")}>{dark ? <Sun aria-hidden /> : <Moon aria-hidden />}</Button>;
}
