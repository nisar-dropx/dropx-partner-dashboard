"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";

/**
 * Network-level Ageing/Performance tabs — real routes with a persistent tab
 * strip, mirroring CodSectionTabs (Executive Reconciliation / COD
 * Submission / COD Reports / Cash In Associate) rather than a client-state
 * toggle: proper URLs, back/forward, and the same visual language as the
 * rest of Ops Pulse.
 */
export function EddSectionTabs({ active }: { active: "ageing" | "performance" }) {
  const pathname = usePathname();
  const sections = [
    { href: "/edd", key: "ageing" as const, label: "Ageing" },
    { href: "/edd/performance", key: "performance" as const, label: "Performance" }
  ];

  return (
    <section className="tabs" aria-label="Delivery Performance sections">
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
