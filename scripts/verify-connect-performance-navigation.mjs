import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const flow = read("apps/connect/src/components/connect-login-flow.tsx");
const dashboard = read("apps/connect/src/components/connect-dashboard.tsx");
const auth = read("apps/connect/src/lib/connect-auth.ts");
const performance = read("apps/connect/src/components/connect-performance.tsx");
const performanceApi = read("apps/connect/app/api/connect/performance/route.ts");
const performanceData = read("apps/connect/src/lib/connect-operational-performance.ts");
const performancePeriods = read("apps/connect/src/lib/performance-periods.ts");
const styles = read("apps/connect/app/globals.css");
const mobileNav = flow.slice(flow.indexOf('aria-label="Primary navigation"'), flow.indexOf("</nav> : null}", flow.indexOf('aria-label="Primary navigation"')));

const checks = [
  [auth.includes('profileType === "employee" || profileType === "contractor"') && auth.includes('? ["performance"]'), "employee and independent-contractor accounts inherit Performance without a designation tick"],
  [flow.includes('page === "performance" && (account?.profileType === "employee" || account?.profileType === "contractor")') && dashboard.includes('account.profileType === "employee" || account.profileType === "contractor" || pageAccess.includes("performance")'), "current employee and contractor sessions expose Performance even when older access arrays omit it"],
  [performanceApi.includes('clean(department.data?.code).toUpperCase() === "OPS"') && performanceApi.includes("context.operationsEligible") && performanceApi.includes(": Promise.resolve(null)"), "operational scorecard and CPS data are restricted server-side to the active People Operations department"],
  [performance.includes('const visibleSection = operational ? section : "reviews"') && performance.includes('{operational ? <nav className="dx-performance-sections"') && performance.includes("Your goals, feedback and individual performance reviews."), "non-Operations people receive the individual performance view without Scorecard or CPS controls"],
  [mobileNav.includes("<span>Performance</span>") && !mobileNav.includes("<span>Approvals</span>") && !mobileNav.includes("<span>Profile</span>") && !mobileNav.includes("<span>Settings</span>"), "mobile primary row prioritises performance while approvals remain in Home and the menu"],
  [styles.includes("grid-template-columns: repeat(5, minmax(0, 1fr))"), "mobile primary navigation has a fixed one-row five-action grid"],
  [performance.includes('setSection("cps")') && performance.includes('aria-label="Performance sections"'), "CPS has a separate monthly section"],
  [performance.includes("availableCpsMonths") && performance.includes('query.set("cpsMonth", cpsMonth)') && performanceData.includes("oldestCpsResult"), "CPS exposes current MTD and every closed month available in scoped history"],
  [performanceData.includes('cpsPeriodState: "mtd" | "closed"') && performance.includes('"MTD CPS" : "Monthly CPS"') && !performance.includes('"MTD" : "Closed"'), "CPS labels the current month as MTD without showing a redundant closed badge"],
  [performance.includes("weekRangeLabel") && performanceData.includes("availableWeekPeriods") && performanceData.includes("selectedWeekStart") && performancePeriods.includes("Sunday-Saturday"), "scorecard weeks show their Sunday-Saturday calendar date range"],
  [performance.includes("unitPerformance(station.unitType)") && performanceData.includes("locationUnit"), "scorecards label station, store or hub performance from the location model"],
  [performanceData.includes('currentMonthStart(`${selectedCpsMonth}-01`)') && performanceData.includes("monthEnd(selectedCpsMonth)"), "CPS reads the exact selected open or closed month"],
  [performance.includes("dx-performance-metric-grid") && styles.includes("grid-template-columns:repeat(2,minmax(0,1fr));gap:5px"), "mobile scorecard metrics remain compact two-column tiles"],
  [!performance.includes("CPS / target") && !performance.includes("CPS ₹"), "weekly scorecard cards do not mix in CPS"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
