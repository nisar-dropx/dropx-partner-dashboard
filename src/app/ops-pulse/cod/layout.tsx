import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import "../../cia-associate.css";

/**
 * Keeps sidebar + top bar mounted while COD child routes stream.
 * loading.tsx only replaces the main content area inside the shell.
 */
export default function CodSectionLayout({ children }: { children: ReactNode }) {
  return <AppShell active="COD" pageCode="cod">{children}</AppShell>;
}
