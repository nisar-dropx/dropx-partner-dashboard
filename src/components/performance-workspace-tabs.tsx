import Link from "next/link";

export function PerformanceWorkspaceTabs({ active }: { active: "daily" | "sls" | "reviews" }) {
  return <nav className="performance-tabs performance-workspace-tabs">
    <Link className={active === "daily" ? "active" : ""} href="/ops-pulse/performance?view=daily">Daily performance</Link>
    <Link className={active === "reviews" ? "active" : ""} href="/ops-pulse/performance?view=reviews">Review desk</Link>
    <Link className={active === "sls" ? "active" : ""} href="/ops-pulse/performance?view=sls">Amazon SLS</Link>
  </nav>;
}
