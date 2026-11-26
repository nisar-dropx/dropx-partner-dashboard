import Link from "next/link";

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
    <nav className="workspace-tabs" aria-label="Dark Store Operations">
      {canViewLive ? (
        <Link className={active === "live" ? "active" : ""} href="/operations/live">
          Live performance
        </Link>
      ) : null}
      {canViewPpi ? (
        <Link className={active === "ppi" ? "active" : ""} href="/operations/ppi">
          PPI
        </Link>
      ) : null}
      {canViewSite ? (
        <Link className={active === "site" ? "active" : ""} href="/operations/site-summary">
          Site Summary
        </Link>
      ) : null}
      {canViewPulse ? (
        <Link className={active === "pulse" ? "active" : ""} href="/operations/workforce-pulse">
          Workforce Pulse
        </Link>
      ) : null}
      {canViewColdChain ? (
        <Link className={active === "cold-chain" ? "active" : ""} href="/operations/cold-chain">
          Cold chain alerts
        </Link>
      ) : null}
      {canViewPolicies ? (
        <Link className={active === "policies" ? "active" : ""} href="/operations/message-policies">
          Message policies
        </Link>
      ) : null}
    </nav>
  );
}
