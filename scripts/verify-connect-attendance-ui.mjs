import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const component = readFileSync(resolve(root, "apps/connect/src/components/connect-attendance.tsx"), "utf8");
const styles = readFileSync(resolve(root, "apps/connect/app/globals.css"), "utf8");
const payDay = readFileSync(resolve(root, "src/lib/attendance-pay-day.ts"), "utf8");
const insights = readFileSync(resolve(root, "apps/connect/src/lib/attendance-insights.ts"), "utf8");

const checks = [
  [component.includes('aria-controls="attendance-day-details"') && component.includes("scrollIntoView"), "View details opens and focuses the selected day"],
  [component.includes('setSelected((current) => current ?') && !component.includes("payload.rows?.at(-1)"), "the latest day is not expanded automatically"],
  [component.includes('!["full", "off"].includes(selectedInsight.calendarClass)') && component.includes("selectedTimingIssues"), "full-day boilerplate is omitted while timing consequences remain"],
  [component.includes('className="paid-leave"') && component.includes(">Paid leave<") && component.includes(">Leave<") && component.includes("Week off / holiday") && !component.includes('className="wfh"'), "legend merges WFH into paid leave and holiday into week off"],
  [payDay.includes('case "present_wfh":') && payDay.includes('return "paid-leave"') && payDay.includes('case "paid_holiday":') && payDay.includes('return "week-off"'), "calendar maps WFH to paid-leave and holiday to week-off"],
  [insights.includes('calendarClass: "paid-leave"') && insights.includes('label: "Present · WFH"'), "day details still surface Present · WFH on click"],
  [styles.includes("background: #4f46e5") && styles.includes("background: #b91c1c") && styles.includes("background: #fbbf24") && styles.includes("background: #475569") && styles.includes("background: transparent"), "calendar colors separate full, paid leave, absent, review, week off, and no-record"],
  [styles.includes(".dx-attendance-day-insight.compact") && styles.includes("repeat(4, minmax(0, 1fr))"), "mobile day details use the compact layout"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
