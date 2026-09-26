"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";

export function AccessTokenForm({ invalid, onSubmit }: { invalid: boolean; onSubmit: (token: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  return <form className="mx-auto max-w-xl space-y-4 rounded-xl border border-border p-5" onSubmit={event => {
    event.preventDefault();
    onSubmit(value);
    setValue("");
  }}>
    <h3 className="text-lg font-semibold">{t("access.title")}</h3>
    <p className="text-sm text-muted-foreground">{t("access.help")}</p>
    {invalid && <Alert variant="destructive"><AlertDescription>{t("access.invalid")}</AlertDescription></Alert>}
    <Label htmlFor="access-token">{t("access.token")}</Label>
    <Input id="access-token" type="password" value={value} onChange={event => setValue(event.target.value)} required autoComplete="off" autoFocus />
    <Button type="submit">{t("access.submit")}</Button>
  </form>;
}
