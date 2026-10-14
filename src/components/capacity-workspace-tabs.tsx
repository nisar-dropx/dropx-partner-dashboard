"use client";

import { useSearchParams } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import type { CapacityWorkspaceTab } from "@/lib/ops-pulse/capacity-access";

export function CapacityWorkspaceTabs({ active, allowed }: { active: CapacityWorkspaceTab; allowed: CapacityWorkspaceTab[] }) {
  const searchParams = useSearchParams();
  const selectedStations = searchParams.get("stations");
  const withScope = (path: string) => selectedStations ? `${path}?stations=${encodeURIComponent(selectedStations)}` : path;

  return <nav className="performance-tabs performance-workspace-tabs">
    {allowed.includes("overview") ? <PendingLink className={active === "overview" ? "active" : ""} disableWhenCurrent href={withScope("/ops-pulse/capacity")}>Capacity overview</PendingLink> : null}
    {allowed.includes("associates") ? <PendingLink className={active === "associates" ? "active" : ""} disableWhenCurrent href={withScope("/ops-pulse/capacity/associates")}>Associate SPR</PendingLink> : null}
    {allowed.includes("delivery") ? <PendingLink className={active === "delivery" ? "active" : ""} disableWhenCurrent href={withScope("/ops-pulse/performance/shipments")}>Delivery data</PendingLink> : null}
    {allowed.includes("distance") ? <PendingLink className={active === "distance" ? "active" : ""} disableWhenCurrent href={withScope("/ops-pulse/capacity/distance")}>Distance &amp; Fuel</PendingLink> : null}
  </nav>;
}
