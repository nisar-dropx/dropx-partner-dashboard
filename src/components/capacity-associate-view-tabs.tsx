"use client";

import { useSearchParams } from "next/navigation";
import { PendingLink } from "@/components/pending-link";

export function CapacityAssociateViewTabs({ active }: { active: "productivity" | "recommendations" | "low-productivity" }) {
  const searchParams = useSearchParams();

  function href(view: "productivity" | "recommendations") {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("sort");
    params.delete("dir");
    if (view === "productivity") params.delete("view");
    else params.set("view", "recommendations");
    const query = params.toString();
    return `/ops-pulse/capacity/associates${query ? `?${query}` : ""}`;
  }

  return <nav className="capacity-view-tabs" aria-label="Associate SPR view">
    <PendingLink className={active === "productivity" ? "active" : ""} disableWhenCurrent href={href("productivity")}>
      Productivity
    </PendingLink>
    <PendingLink className={active === "recommendations" ? "active" : ""} disableWhenCurrent href={href("recommendations")}>
      SPR recommendations
    </PendingLink>
    <PendingLink className={active === "low-productivity" ? "active" : ""} disableWhenCurrent href="/ops-pulse/capacity/associates/low-productivity">
      Low productivity associates
    </PendingLink>
  </nav>;
}
