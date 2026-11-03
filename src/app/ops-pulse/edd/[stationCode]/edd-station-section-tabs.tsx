"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import type { EddSectionKey } from "@/lib/ops-pulse/edd-access";

/** Station-level tabs — Ageing/Performance only for FSD, Managing Partner, Finance Head. */
export function EddStationSectionTabs({
  stationCode,
  active,
  showAgeingPerformance = false,
  allowedSections,
}: {
  stationCode: string;
  active: "ageing" | "performance" | "edds";
  showAgeingPerformance?: boolean;
  allowedSections?: EddSectionKey[];
}) {
  const pathname = usePathname();
  const base = `/edd/${encodeURIComponent(stationCode)}`;
  const allowed = new Set(allowedSections ?? ["ageing", "performance", "edds"]);
  const sections = [
    ...(showAgeingPerformance
      ? [
          { href: base, key: "ageing" as const, label: "Ageing" },
          { href: `${base}/performance`, key: "performance" as const, label: "Performance" },
        ]
      : []),
    { href: `${base}/edds`, key: "edds" as const, label: "EDDs" },
  ].filter((section) => allowed.has(section.key));

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
