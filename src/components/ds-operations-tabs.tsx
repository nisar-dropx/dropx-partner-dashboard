import Link from "next/link";

export function DsOperationsTabs({
  active,
  canViewLive = false,
  canViewPpi = false,
  canViewSite = false,
  canViewColdChain = false
}: {
  active: "live" | "ppi" | "site" | "cold-chain";
  canViewLive?: boolean;
  canViewPpi?: boolean;
  canViewSite?: boolean;
  canViewColdChain?: boolean;
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
      {canViewColdChain ? (
        <Link className={active === "cold-chain" ? "active" : ""} href="/operations/cold-chain">
          Cold chain alerts
        </Link>
      ) : null}
    </nav>
  );
}
