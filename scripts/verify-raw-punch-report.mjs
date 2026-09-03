import fs from "node:fs";

const page = fs.readFileSync("src/app/reports/raw-punches/page.tsx", "utf8");
const filters = fs.readFileSync("src/components/raw-punch-report-filters.tsx", "utf8");
const exportRoute = fs.readFileSync("src/app/api/reports/raw-punches/export/route.ts", "utf8");
const resolver = fs.readFileSync("src/lib/biometric/raw-punch-report.ts", "utf8");

const checks = [
  [page.includes("<RawPunchReportFilters"), "Raw Punches must render the multi-select filters."],
  [page.includes("Download Excel"), "Raw Punches must expose the Excel download."],
  [filters.includes('value: "people"') && filters.includes('value: "workforce"') && filters.includes('value: "unmapped"'), "Mapping choices must distinguish People, Workforce, and Unmapped."],
  [filters.includes("Select all") && filters.includes('type="checkbox"'), "Categorical filters must support multi-tick selection."],
  [exportRoute.includes('requirePagePermission("raw_punch_reports", "access")'), "The export must enforce Raw Punches permission."],
  [exportRoute.includes("authorization.locationScopeIds"), "The export must enforce location scope."],
  [exportRoute.includes('bookType: "xlsx"'), "The export must generate an XLSX workbook."],
  [resolver.includes('match: "serial"') && resolver.includes('match: "terminal"') && resolver.includes('match: "network"'), "Location resolution must support serial, terminal, and network fallbacks."]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("Raw Punches report verification passed.");
