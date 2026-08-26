"use client";

import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PendingLink } from "@/components/pending-link";

/**
 * Station-level Ageing/Performance tabs, with "All stations" folded in as
 * an inline back-link on the same row instead of a separate line above the
 * page header — and, importantly, pointed at whichever network overview
 * matches the active tab (Ageing → /edd, Performance → /edd/performance),
 * not always /edd regardless of where you actually came from.
 */
export function EddStationSectionTabs({ stationCode, active }: { stationCode: string; active: "ageing" | "performance" }) {
  const pathname = usePathname();
  const base = `/edd/${encodeURIComponent(stationCode)}`;
  const sections = [
    { href: base, key: "ageing" as const, label: "Ageing" },
    { href: `${base}/performance`, key: "performance" as const, label: "Performance" }
  ];
  const backHref = active === "performance" ? "/edd/performance" : "/edd";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <PendingLink className="edd-back-link" href={backHref}>
        <ArrowLeft size={14} /> All stations
      </PendingLink>
      <section className="tabs" aria-label={`${stationCode} sections`}>
        {sections.map((section) => {
          const isActive =
            active === section.key ||
            pathname === section.href ||
            pathname === `/ops-pulse${section.href}`;
          return (
            <PendingLink
              className={`tab ${isActive ? "active" : ""}`}
              href={section.href}
              key={section.key}
              disableWhenCurrent
            >
              {section.label}
            </PendingLink>
          );
        })}
      </section>
    </div>
  );
}
