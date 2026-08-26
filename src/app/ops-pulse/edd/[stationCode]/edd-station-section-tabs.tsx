"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";

/** Station-level Ageing/Performance tabs — same real-route pattern as EddSectionTabs, scoped to one station. */
export function EddStationSectionTabs({ stationCode, active }: { stationCode: string; active: "ageing" | "performance" }) {
  const pathname = usePathname();
  const base = `/edd/${encodeURIComponent(stationCode)}`;
  const sections = [
    { href: base, key: "ageing" as const, label: "Ageing" },
    { href: `${base}/performance`, key: "performance" as const, label: "Performance" }
  ];

  return (
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
  );
}
