"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import { useCodPendingAccess } from "@/components/cod-pending-access-provider";

const codSections = [
  { href: "/cod/executive-reconciliation", key: "executive-reconciliation", label: "Executive Reconciliation", visible: true },
  { href: "/cod/submission", key: "submission", label: "COD Submission", visible: true },
  { href: "/cod/reports", key: "reports", label: "COD Reports", visible: true },
  { href: "/cod/cash-in-associate", key: "cash-in-associate", label: "Cash In Associate", visible: true },
  { href: "/cod/validation", key: "validation", label: "Validation", visible: false },
  { href: "/cod/portal-checks", key: "portal-checks", label: "Portal Checks", visible: false },
  { href: "/cod/pending", key: "pending", label: "Daily COD Review", visible: true }
] as const;

export function CodSectionTabs({ active }: { active: typeof codSections[number]["key"] }) {
  const pathname = usePathname();
  const canViewPending = useCodPendingAccess();

  return (
    <section className="tabs" aria-label="COD sections">
      {codSections.filter((section) => section.visible && (section.key !== "pending" || canViewPending)).map((section) => {
        const isActive =
          active === section.key ||
          pathname === section.href ||
          pathname.startsWith(`${section.href}/`) ||
          pathname === `/ops-pulse${section.href}` ||
          pathname.startsWith(`/ops-pulse${section.href}/`);
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
