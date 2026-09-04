import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const page = read("src/app/cps/adhoc-activity/page.tsx");
const data = read("src/lib/ops-pulse/adhoc-activity.ts");
const filters = read("src/components/cps-adhoc-filters.tsx");
const table = read("src/components/cps-adhoc-table.tsx");

const checks = [
  [navigation.includes('label: "Adhoc Van & DA", href: "/cps/adhoc-activity"'), "CPS navigation must expose the Adhoc Van & DA submenu."],
  [page.includes('requirePagePermission("cps_overview", "access")') && page.includes("authorization.locationScopeIds"), "The page must enforce CPS access and the signed-in user's location scope."],
  [data.includes('.in("location_id", locationIds)') && data.includes('.gte("work_date", from)') && data.includes('.lte("work_date", to)'), "The source query must be restricted to permitted locations and the selected month."],
  [data.includes("isApprovedPayment(request)") && data.includes('["Van", "DA"]'), "Only carried-out Van and DA requests may be counted."],
  [filters.includes('label="Clusters"') && filters.includes('label="Stations"') && filters.includes('type="month"'), "The filter bar must support month, cluster and multi-station selection."],
  [table.includes("day-level activity") && table.includes("setExpanded"), "Station totals must expand into day-level detail without leaving the table."],
  [page.includes("Pending, returned and rejected requests are excluded"), "The counting rule must remain visible to users."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`CPS Adhoc activity verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("CPS Adhoc Van & DA scope, filters and day-level table verified.");
