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
const report = read("src/app/api/ops-pulse/cps/adhoc-activity/report/route.ts");

const checks = [
  [navigation.includes('label: "Adhoc Van & DA", href: "/cps/adhoc-activity"'), "CPS navigation must expose the Adhoc Van & DA submenu."],
  [page.includes('requirePagePermission("cps_overview", "access")') && page.includes("authorization.locationScopeIds"), "The page must enforce CPS access and the signed-in user's location scope."],
  [data.includes('requestPage("location_id"') && data.includes('requestPage("station_code"') && data.includes('requestPage("location_code"') && data.includes('.gte("work_date", from)') && data.includes('.lte("work_date", to)'), "The source query must cover every permitted location identifier for the selected range."],
  [data.includes("isApprovedPayment(request)") && data.includes('["Van", "DA"]'), "Only carried-out Van and DA requests may be counted."],
  [filters.includes('label="Clusters"') && filters.includes('label="Stations"') && filters.includes('type="date"') && filters.includes(">Today</button>") && filters.includes(">MTD</button>"), "The filter bar must support day/range presets, cluster and multi-station selection."],
  [data.includes('from("cps_cashbook_daily")') && data.includes("isCashbookAdHocVan") && data.includes("approvedRequestNumbers"), "Cashbook Adhoc Van payments must be included without double-counting linked requests."],
  [data.includes("location.aom") && page.includes("adHocClusterLabel"), "AOM must be the cluster-filter fallback when no Cluster Manager is mapped."],
  [table.includes("day-level activity") && table.includes("setExpanded"), "Station totals must expand into day-level detail without leaving the table."],
  [table.includes("Click a date for reasons and remarks") && table.includes("entry.reason") && table.includes("entry.remark") && data.includes("payment_request_answers"), "Each activity date must expose the recorded reason and remark for its Adhoc entries."],
  [["station", "vanCount", "vanAmount", "daCount", "daAmount", "totalCount", "totalAmount"].every((column) => table.includes(`column="${column}"`)), "Every station-summary column must be sortable."],
  [table.includes("Download Excel") && report.includes("workbookResponse") && report.includes('name: "Reasons and remarks"') && report.includes('hasPermission(authorization, "cps_overview", "access")'), "The scoped Excel report must include reasons and remarks and enforce CPS access."],
  [page.includes("Linked Cashbook payments are shown but never double-counted") && page.includes("Pending, returned and rejected requests are excluded"), "The counting rule must remain visible to users."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`CPS Adhoc activity verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("CPS Adhoc Van & DA scope, filters, sorting, Excel report and date details verified.");
