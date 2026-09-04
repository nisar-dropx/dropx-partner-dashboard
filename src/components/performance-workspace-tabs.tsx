import Link from "next/link";

export function PerformanceWorkspaceTabs({ active, canViewReviews }: { active: "daily" | "sls" | "reviews"; canViewReviews: boolean }) {
  return <nav className="performance-tabs performance-workspace-tabs">
    <Link className={active === "daily" ? "active" : ""} href="/performance?view=daily">Daily performance</Link>
    {canViewReviews ? <Link className={active === "reviews" ? "active" : ""} href="/performance?view=reviews">Review desk</Link> : null}
    <Link className={active === "sls" ? "active" : ""} href="/performance?view=sls">Amazon SLS</Link>
  </nav>;
}
