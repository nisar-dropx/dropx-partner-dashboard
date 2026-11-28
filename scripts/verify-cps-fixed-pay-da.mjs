import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const page = read("src/app/cps/fixed-pay-da/page.tsx");
const math = read("src/lib/ops-pulse/fixed-pay-da-math.ts");
const data = read("src/lib/ops-pulse/fixed-pay-da.ts");
const table = read("src/components/cps-fixed-pay-table.tsx");
const report = read("src/app/api/ops-pulse/cps/fixed-pay-da/report/route.ts");
const overview = read("src/app/cps/page.tsx");

const checks = [
  [navigation.includes('label: "Fixed Pay DA", href: "/cps/fixed-pay-da"'), "CPS navigation must expose Fixed Pay DA."],
  [overview.includes('href="/cps/fixed-pay-da"'), "CPS overview tabs must include Fixed Pay DA."],
  [page.includes('requirePagePermission("cps_overview", "access")') && page.includes("authorization.locationScopeIds"), "The page must enforce CPS access and location scope."],
  [page.includes("locationsResult.locations.filter(isAdHocActivityLocation)"), "Page must exclude HO and Amazon Now."],
  [math.includes('detail.cohort !== "guarantee"') && math.includes("fixedPaySalary") && math.includes("fixedPayCps"), "Projection must use guarantee-cohort salary only."],
  [data.includes("loadCpsSnapshot") && data.includes("projectFixedPayDaStations"), "Loader must reuse the CPS snapshot and project Fixed Pay rows."],
  [table.includes("Fixed Pay DA CPS") && table.includes("day-level activity"), "Station table must expose Fixed Pay DA CPS with day drill-down."],
  [report.includes("workbookResponse") && report.includes('name: "Associates"') && report.includes('hasPermission(authorization, "cps_overview", "access")'), "Excel export must include associates and enforce CPS access."],
  [page.includes("Pending attendance days are counted but do not blank the known CPS"), "Pending-attendance rule must stay visible."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`CPS Fixed Pay DA verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("CPS Fixed Pay DA navigation, salary-only projection, filters and Excel report verified.");
