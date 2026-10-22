import Link from "next/link";
import styles from "./si-handover.module.css";

type HubTab = "shift" | "store" | "report";

export function ActivitiesHub({
  active,
  showShift = true,
  showStore = true,
  showReport = true,
}: {
  active: HubTab;
  showShift?: boolean;
  showStore?: boolean;
  showReport?: boolean;
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
      id: "report",
      label: "Report",
      href: "/si-handover/report",
      show: showReport,
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
          href={
            t.id === "report" && active === "report"
              ? t.href
              : t.id === "report"
                ? "/si-handover/report"
                : t.href
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
