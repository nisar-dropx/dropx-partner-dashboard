"use client";

import { usePathname } from "next/navigation";
import { CodSectionTabs } from "@/components/cod-section-tabs";

type CodTabKey =
  | "executive-reconciliation"
  | "submission"
  | "reports"
  | "cash-in-associate"
  | "validation"
  | "portal-checks";

function tabFromPath(pathname: string): CodTabKey {
  if (pathname.includes("/cod/submission")) return "submission";
  if (pathname.includes("/cod/reports")) return "reports";
  if (pathname.includes("/cod/cash-in-associate")) return "cash-in-associate";
  if (pathname.includes("/cod/validation")) return "validation";
  if (pathname.includes("/cod/portal-checks")) return "portal-checks";
  return "executive-reconciliation";
}

export function CodSectionTabsFromPath() {
  const pathname = usePathname() || "";
  return <CodSectionTabs active={tabFromPath(pathname)} />;
}
