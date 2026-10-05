"use client";

import { ArrowUp, FileKey, Folder, FolderOpen, Home, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n/provider";
import type { DirectoryListing } from "@/shared/contracts";

interface CertificateFilePickerProps {
  id: string;
  token: string;
  value: string;
  onChange: (path: string) => void;
  placeholder: string;
  required?: boolean;
}

function containingDirectory(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : undefined;
}

export function CertificateFilePicker({
  id,
  token,
  value,
  onChange,
  placeholder,
  required = false,
}: CertificateFilePickerProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (path?: string) => {
    if (!token) return setError(t("dashboard.sessionPending"));
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ files: "certificates" });
      if (path) query.set("path", path);
      const response = await fetch(`/api/directories?${query}`, {
        cache: "no-store",
        headers: {
          "Accept-Language": locale,
          "X-Worktree-Control-Token": token,
        },
      });
      const body = await response.json() as DirectoryListing & { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("http.error", { status: response.status }));
      setListing(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => { setOpen(true); void load(containingDirectory(value)); }}
          disabled={!token}
        >
          <FolderOpen aria-hidden />{t("common.browse")}
        </Button>
      </div>

      {open && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-3 flex items-center gap-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("picker.parent")}
              disabled={!listing?.parent || loading}
              onClick={() => void load(listing?.parent ?? undefined)}
            >
              <ArrowUp aria-hidden />
            </Button>
            <p className="min-w-0 flex-1 truncate font-mono text-xs" title={listing?.current}>
              {listing?.current ?? t("picker.loadingDirectory")}
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
              <Home aria-hidden />{t("common.home")}
            </Button>
          </div>

          <ScrollArea className="h-52 rounded-md border bg-background/60">
            {loading ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
                {t("picker.readingFiles")}
              </div>
            ) : (
              <div className="p-1" aria-label={t("picker.certificateFiles")}>
                {listing?.directories.map((directory) => (
                  <Button
                    key={directory.path}
                    type="button"
                    variant="ghost"
                    className="h-9 w-full justify-start px-2 font-normal"
                    onClick={() => void load(directory.path)}
                  >
                    <Folder className="text-indigo-300" aria-hidden />
                    <span className="truncate">{directory.name}</span>
                  </Button>
                ))}
                {listing?.files.map((file) => (
                  <Button
                    key={file.path}
                    type="button"
                    variant="ghost"
                    className="h-9 w-full justify-start px-2 font-normal"
                    onClick={() => { onChange(file.path); setOpen(false); }}
                  >
                    <FileKey className="text-success-foreground" aria-hidden />
                    <span className="truncate">{file.name}</span>
                  </Button>
                ))}
                {!loading && !listing?.directories.length && !listing?.files.length && (
                  <p className="p-6 text-center text-sm text-muted-foreground">{t("picker.noCertificateFiles")}</p>
                )}
              </div>
            )}
          </ScrollArea>
          {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
          <div className="mt-3 flex justify-end">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("common.close")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
