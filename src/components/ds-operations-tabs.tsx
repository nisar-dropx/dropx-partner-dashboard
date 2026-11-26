import Link from "next/link";
import { Activity, BarChart2, Bell, BellRing, Thermometer, Users } from "lucide-react";
import s from "./ds-operations-tabs.module.css";

const TAB_ICON: Record<string, React.ReactNode> = {
  live: <Activity size={14} aria-hidden />,
  ppi: <BarChart2 size={14} aria-hidden />,
  site: <Users size={14} aria-hidden />,
  pulse: <Users size={14} aria-hidden />,
  "cold-chain": <Thermometer size={14} aria-hidden />,
  policies: <BellRing size={14} aria-hidden />
};

export function DsOperationsTabs({
  active,
  canViewLive = false,
  canViewPpi = false,
  canViewSite = false,
  canViewColdChain = false,
  canViewPulse = false,
  canViewPolicies = false
}: {
  active: "live" | "ppi" | "site" | "cold-chain" | "pulse" | "policies";
  canViewLive?: boolean;
  canViewPpi?: boolean;
  canViewSite?: boolean;
  canViewColdChain?: boolean;
  canViewPulse?: boolean;
  canViewPolicies?: boolean;
}) {
  return (
    <nav className={s.nav} aria-label="Dark Store Operations">
      {canViewLive ? (
        <Link className={`${s.tab}${active === "live" ? ` ${s.active}` : ""}`} href="/operations/live">
          <span className={s.icon}>{TAB_ICON.live}</span>
          Live performance
          {active === "live" && <span className={s.dot} aria-label="live" />}
        </Link>
      ) : null}
      {canViewPpi ? (
        <Link className={`${s.tab}${active === "ppi" ? ` ${s.active}` : ""}`} href="/operations/ppi">
          <span className={s.icon}>{TAB_ICON.ppi}</span>
          PPI
        </Link>
      ) : null}
      {canViewSite ? (
        <Link className={`${s.tab}${active === "site" ? ` ${s.active}` : ""}`} href="/operations/site-summary">
          <span className={s.icon}>{TAB_ICON.site}</span>
          Site Summary
        </Link>
      ) : null}
      {canViewPulse ? (
        <Link className={`${s.tab}${active === "pulse" ? ` ${s.active}` : ""}`} href="/operations/workforce-pulse">
          <span className={s.icon}>{TAB_ICON.pulse}</span>
          Workforce Pulse
        </Link>
      ) : null}
      {canViewColdChain ? (
        <Link className={`${s.tab}${active === "cold-chain" ? ` ${s.active}` : ""}`} href="/operations/cold-chain">
          <span className={s.icon}>{TAB_ICON["cold-chain"]}</span>
          Cold chain alerts
        </Link>
      ) : null}
      {canViewPolicies ? (
        <Link className={`${s.tab}${active === "policies" ? ` ${s.active}` : ""}`} href="/operations/message-policies">
          <span className={s.icon}>{TAB_ICON.policies}</span>
          Message policies
        </Link>
      ) : null}
    </nav>
  );
}
