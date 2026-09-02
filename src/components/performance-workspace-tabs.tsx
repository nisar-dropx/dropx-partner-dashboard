import Link from "next/link";

export function PerformanceWorkspaceTabs({ active, canViewReviews }: { active: "daily" | "sls" | "reviews"; canViewReviews: boolean }) {
  return <nav className="performance-tabs performance-workspace-tabs">
    <Link className={active === "daily" ? "active" : ""} href="/ops-pulse/performance?view=daily">Daily performance</Link>
    {canViewReviews ? <Link className={active === "reviews" ? "active" : ""} href="/ops-pulse/performance?view=reviews">Review desk</Link> : null}
    <Link className={active === "sls" ? "active" : ""} href="/ops-pulse/performance?view=sls">Amazon SLS</Link>
  </nav>;
}
