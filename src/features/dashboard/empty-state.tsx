"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n/provider";
import { GitCommitHorizontal, Plus } from "lucide-react";
import type { Ref } from "react";

export function EmptyState({ onAdd, buttonRef }: { onAdd: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  const { t } = useI18n();
  return (
    <Card className="mx-auto max-w-2xl border-dashed bg-card/45 py-10 text-center">
      <CardContent className="grid justify-items-center">
        <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-muted"><GitCommitHorizontal className="size-6 text-muted-foreground" aria-hidden /></div>
        <h2 className="text-xl font-semibold">{t("empty.title")}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("empty.description")}</p>
        <Button ref={buttonRef} className="mt-6" onClick={onAdd}><Plus aria-hidden />{t("empty.action")}</Button>
      </CardContent>
    </Card>
  );
}
