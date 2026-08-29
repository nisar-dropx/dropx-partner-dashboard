import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const route = read("apps/connect/app/api/connect/roster/route.ts");
const component = read("apps/connect/src/components/connect-roster.tsx");

const checks = [
  [route.includes('.eq("hr_roster_plans.status", "approved")') && route.includes('.eq("hr_roster_plans.roster_kind", "recurring_weekly")'), "recurring projection reads only approved weekly plans"],
  [route.includes('.eq("location_id", locationId)') && route.includes('.eq("worker_id", account.id)'), "recurring projection remains scoped to the signed-in worker and location"],
  [route.includes("requester_shift_id,partner_shift_id,requester_day_type,partner_day_type"), "swap history loads immutable shift and day snapshots"],
  [route.includes("storedShiftIds") && route.includes('db().from("hr_shifts")'), "historical swaps resolve their stored shifts after a roster revision"],
  [route.includes('isProjected: entry.id.startsWith("preview:")') && component.includes('day.isProjected ? "Recurring schedule"'), "recurring dates never show a false cutoff warning"],
  [component.includes("activeRequests") && component.includes("completedRequests"), "active requests and completed history are separated"],
  [component.includes("Recent swap history") && component.includes("You requested with"), "swap history is compact and shows request direction"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
