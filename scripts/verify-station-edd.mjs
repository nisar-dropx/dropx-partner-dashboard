import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const accessPages = read("src/lib/access-pages.ts");
const authorization = read("src/lib/authorization.ts");
const accessSurface = read("src/lib/access-surface.ts");
const permissions = read("src/components/permission-matrix.tsx");
const networkPage = read("src/app/ops-pulse/station-edd/page.tsx");
const networkClient = read("src/app/ops-pulse/station-edd/station-edd-network-client.tsx");
const detailClient = read("src/app/ops-pulse/station-edd/[stationCode]/station-edd-detail-client.tsx");
const stationReport = read("src/app/api/ops-pulse/station-edd/report/route.ts");
const stationApi = read("src/app/api/ops-pulse/station-edd/route.ts");

const checks = [
  [navigation.includes('code: "station_edd", label: "EDD", href: "/station-edd"'), "EDD is a new top-level navigation section"],
  [navigation.includes("eddDashboard, stationEdd"), "Delivery Performance remains present beside the new EDD section"],
  [accessPages.includes('{ code: "station_edd", name: "EDD"'), "EDD has its own access page"],
  [accessPages.includes('["edd_dashboard"], "station_edd"'), "existing Delivery Performance grants seed initial EDD access"],
  [authorization.includes('"edd_dashboard",\n    "station_edd"'), "EDD participates in OpsPulse permission inheritance"],
  [accessSurface.includes('"station_edd"') && permissions.includes('label: "EDD", codes: ["station_edd"]'), "EDD is independently configurable in Users & Access"],
  [networkPage.includes('title="EDD"') && networkClient.includes("At station EDD") && networkClient.includes("Delivered"), "station dashboard exposes the requested current-at-station and delivered counts"],
  [detailClient.includes("TrackingDetailModal") && detailClient.includes("Tracking-ID details"), "station drill-down exposes clickable tracking-ID details"],
  [stationReport.includes('{ name: "At Station EDD", rows: atStationRows }') && stationReport.includes('{ name: "All EDD TIDs", rows: allRows }'), "station download contains focused and complete tracking-ID sheets"],
  [stationApi.includes("locationScopeIds") && stationApi.includes("outside your assigned location scope"), "EDD detail API enforces location scope"]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
for (const [passed, message] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
if (failures.length) {
  console.error(`Station EDD verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
