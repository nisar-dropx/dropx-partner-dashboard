"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";

/** Station-level tabs — Ageing/Performance only for FSD, Managing Partner, Finance Head. */
export function EddStationSectionTabs({
  stationCode,
  active,
  showAgeingPerformance = false,
}: {
  stationCode: string;
  active: "ageing" | "performance" | "edds";
  showAgeingPerformance?: boolean;
}) {
  const pathname = usePathname();
  const base = `/edd/${encodeURIComponent(stationCode)}`;
  const sections = [
    ...(showAgeingPerformance
      ? [
          { href: base, key: "ageing" as const, label: "Ageing" },
          { href: `${base}/performance`, key: "performance" as const, label: "Performance" },
        ]
      : []),
    { href: `${base}/edds`, key: "edds" as const, label: "EDDs" },
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
