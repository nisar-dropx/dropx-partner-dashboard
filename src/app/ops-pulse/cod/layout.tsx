import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { getAuthorization } from "@/lib/authorization";
import { canAccessDailyCodPending } from "@/lib/ops-pulse/cod-pending-access";
import { CodPendingAccessProvider } from "@/components/cod-pending-access-provider";
import "../../cia-associate.css";

/**
 * Keeps sidebar + top bar mounted while COD child routes stream.
 * loading.tsx only replaces the main content area inside the shell.
 */
export default async function CodSectionLayout({ children }: { children: ReactNode }) {
  const auth=await getAuthorization();
  return <AppShell active="COD" pageCode="cod"><CodPendingAccessProvider allowed={Boolean(auth&&canAccessDailyCodPending(auth))}>{children}</CodPendingAccessProvider></AppShell>;
}
