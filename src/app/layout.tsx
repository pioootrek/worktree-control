import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/i18n/provider";
import { ProjectSelectionProvider } from "@/features/dashboard/project-selection";

import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Worktree Control",
  description: "A local control plane for worktree-backed development servers.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark`} suppressHydrationWarning>
      <body>
        <I18nProvider><ProjectSelectionProvider><TooltipProvider>{children}</TooltipProvider></ProjectSelectionProvider></I18nProvider>
      </body>
    </html>
  );
}
