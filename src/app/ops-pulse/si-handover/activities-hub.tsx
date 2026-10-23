import Link from "next/link";
import styles from "./si-handover.module.css";

type HubTab = "shift" | "store" | "shift-report" | "store-report";

export function ActivitiesHub({
  active,
  showShift = true,
  showStore = true,
  showShiftReport = false,
  showStoreReport = false,
}: {
  active: HubTab;
  showShift?: boolean;
  showStore?: boolean;
  showShiftReport?: boolean;
  showStoreReport?: boolean;
}) {
  const tabs: { id: HubTab; label: string; href: string; show: boolean }[] = [
    {
      id: "shift",
      label: "Shift operations",
      href: "/si-handover?view=start",
      show: showShift,
    },
    {
      id: "store",
      label: "Store operations",
      href: "/store-ops?view=start",
      show: showStore,
    },
    {
      id: "shift-report",
      label: "Shift report",
      href: "/si-handover/report?tab=shift",
      show: showShiftReport,
    },
    {
      id: "store-report",
      label: "Store report",
      href: "/si-handover/report?tab=store",
      show: showStoreReport,
    },
  ];
  const visible = tabs.filter((t) => t.show);
  if (visible.length < 2) return null;
  return (
    <nav className={styles.hubBar} aria-label="Activities & Handover">
      {visible.map((t) => (
        <Link
          key={t.id}
          prefetch={false}
          className={active === t.id ? styles.hubActive : styles.hubTab}
          href={t.href}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
