import Link from "next/link";
import { Bell, LayoutGrid, List, FileBarChart2 } from "lucide-react";
import s from "./ds-operations-tabs.module.css";

const TABS = [
  { id: "panel", href: "/operations/datoms/panel", label: "Panel", icon: <LayoutGrid size={14} aria-hidden /> },
  { id: "list", href: "/operations/datoms/list", label: "List", icon: <List size={14} aria-hidden /> },
  { id: "alerts", href: "/operations/datoms/alerts", label: "Alerts", icon: <Bell size={14} aria-hidden /> },
  { id: "reports", href: "/operations/datoms/reports", label: "Reports", icon: <FileBarChart2 size={14} aria-hidden /> }
] as const;

export type DatomsHubTab = (typeof TABS)[number]["id"];

export function DsDatomsTabs({ active }: { active: DatomsHubTab }) {
  return (
    <nav className={s.nav} aria-label="DATOMS views" style={{ marginTop: 4 }}>
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          className={`${s.tab}${active === tab.id ? ` ${s.active}` : ""}`}
          href={tab.href}
        >
          <span className={s.icon}>{tab.icon}</span>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
