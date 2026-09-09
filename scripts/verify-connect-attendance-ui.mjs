import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const component = readFileSync(resolve(root, "apps/connect/src/components/connect-attendance.tsx"), "utf8");
const styles = readFileSync(resolve(root, "apps/connect/app/globals.css"), "utf8");

const checks = [
  [component.includes('aria-controls="attendance-day-details"') && component.includes("scrollIntoView"), "View details opens and focuses the selected day"],
  [component.includes('setSelected((current) => current ?') && !component.includes("payload.rows?.at(-1)"), "the latest day is not expanded automatically"],
  [component.includes('!["full", "off", "week-off"].includes(selectedInsight.calendarClass)') && component.includes("selectedTimingIssues"), "full-day boilerplate is omitted while timing consequences remain"],
  [component.includes('className="paid-leave"') && component.includes(">Paid leave<") && component.includes(">Leave<") && component.includes(">Week off<") && component.includes(">WFH<"), "legend separates paid leave, unpaid leave, week off, and WFH"],
  [styles.includes(".dx-days button.paid-leave") && styles.includes(".dx-days button.wfh") && styles.includes(".dx-days button.week-off") && styles.includes(".dx-days button.holiday"), "calendar colors cover paid leave, WFH, week off, and holiday"],
  [styles.includes(".dx-attendance-day-insight.compact") && styles.includes("repeat(4, minmax(0, 1fr))"), "mobile day details use the compact layout"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
