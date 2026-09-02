import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const flow = read("apps/connect/src/components/connect-login-flow.tsx");
const performance = read("apps/connect/src/components/connect-performance.tsx");
const performanceData = read("apps/connect/src/lib/connect-operational-performance.ts");
const styles = read("apps/connect/app/globals.css");
const mobileNav = flow.slice(flow.indexOf('aria-label="Primary navigation"'), flow.indexOf("</nav> : null}", flow.indexOf('aria-label="Primary navigation"')));

const checks = [
  [!mobileNav.includes("<span>Profile</span>") && !mobileNav.includes("<span>Settings</span>"), "secondary profile and settings actions stay out of the mobile primary row"],
  [styles.includes("grid-template-columns: repeat(5, minmax(0, 1fr))"), "mobile primary navigation has a fixed one-row five-action grid"],
  [performance.includes('setSection("cps")') && performance.includes("CPS · MTD"), "CPS has a separate monthly section"],
  [performance.includes("unitPerformance(station.unitType)") && performanceData.includes("locationUnit"), "scorecards label station, store or hub performance from the location model"],
  [performanceData.includes('.gte("work_date", currentMonthStart())'), "CPS reads only the current month-to-date window"],
  [performance.includes("dx-performance-metric-grid") && styles.includes("grid-template-columns:repeat(2,minmax(0,1fr));gap:5px"), "mobile scorecard metrics remain compact two-column tiles"],
  [!performance.includes("CPS / target") && !performance.includes("CPS ₹"), "weekly scorecard cards do not mix in CPS"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
