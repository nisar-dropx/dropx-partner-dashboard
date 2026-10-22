import Link from "next/link";

export function PerformanceWorkspaceTabs({
  active,
  canViewReviews,
  canViewReviewStatus,
  darkStore = false
}: {
  active: "daily" | "sls" | "reviews" | "status";
  canViewReviews: boolean;
  canViewReviewStatus: boolean;
  darkStore?: boolean;
}) {
  if (darkStore) {
    return <nav className="performance-tabs performance-workspace-tabs">
      {canViewReviews ? <Link className={active === "reviews" ? "active" : ""} href="/performance?view=reviews">Review desk</Link> : null}
      {canViewReviewStatus ? <Link className={active === "status" ? "active" : ""} href="/performance/review-status">Review status</Link> : null}
    </nav>;
  }
  return <nav className="performance-tabs performance-workspace-tabs">
    <Link className={active === "daily" ? "active" : ""} href="/performance?view=daily">Daily performance</Link>
    {canViewReviews ? <Link className={active === "reviews" ? "active" : ""} href="/performance?view=reviews">Review desk</Link> : null}
    {canViewReviewStatus ? <Link className={active === "status" ? "active" : ""} href="/performance/review-status">Review status</Link> : null}
    <Link className={active === "sls" ? "active" : ""} href="/performance?view=sls">Amazon SLS</Link>
  </nav>;
}
