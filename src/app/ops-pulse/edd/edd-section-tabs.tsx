"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";

/**
 * Network-level Live performance tabs — real routes with a persistent tab
 * strip. Ageing/Performance are admin-only (FSD, Managing Partner, Finance Head).
 */
export function EddSectionTabs({
  active,
  showAgeingPerformance = false,
}: {
  active: "flash" | "board" | "ageing" | "performance" | "edds" | "scorecard";
  showAgeingPerformance?: boolean;
}) {
  const pathname = usePathname();
  const sections = [
    { href: "/edd/flash", key: "flash" as const, label: "Ops Live" },
    { href: "/edd/board", key: "board" as const, label: "Station board" },
    ...(showAgeingPerformance
      ? [
          { href: "/edd", key: "ageing" as const, label: "Ageing" },
          { href: "/edd/performance", key: "performance" as const, label: "Performance" },
        ]
      : []),
    { href: "/edd/edds", key: "edds" as const, label: "EDDs" },
    { href: "/edd/scorecard", key: "scorecard" as const, label: "Scorecard" },
  ];

  return (
    <section className="tabs" aria-label="Live performance sections">
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
