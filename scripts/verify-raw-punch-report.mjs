import fs from "node:fs";
import "./verify-raw-punch-source.mjs";

const page = fs.readFileSync("src/app/reports/raw-punches/page.tsx", "utf8");
const filters = fs.readFileSync("src/components/raw-punch-report-filters.tsx", "utf8");
const exportButton = fs.readFileSync("src/components/raw-punch-export-button.tsx", "utf8");
const exportRoute = fs.readFileSync("src/app/api/reports/raw-punches/export/route.ts", "utf8");
const resolver = fs.readFileSync("src/lib/biometric/raw-punch-report.ts", "utf8");
const mapping = fs.readFileSync("src/lib/biometric/raw-punch-mapping.ts", "utf8");
const xlsxStream = fs.readFileSync("src/lib/xlsx-stream.ts", "utf8");

const checks = [
  [page.includes("<RawPunchReportFilters"), "Raw Punches must render the multi-select filters."],
  [page.includes("<RawPunchExportButton") && exportButton.includes("Download Excel"), "Raw Punches must expose the Excel download."],
  [page.includes('{ count: "exact" }'), "Filtered result totals must use the exact database count."],
  [filters.includes('value: "people"') && filters.includes('value: "workforce"') && filters.includes('value: "unmapped"'), "Mapping choices must distinguish People, Workforce, and Unmapped."],
  [filters.includes("Select all") && filters.includes('type="checkbox"'), "Categorical filters must support multi-tick selection."],
  [exportRoute.includes('requirePagePermission("raw_punch_reports", "access")'), "The export must enforce Raw Punches permission."],
  [exportRoute.includes("authorization.locationScopeIds"), "The export must enforce location scope."],
  [exportRoute.includes("createStreamingXlsx") && xlsxStream.includes("streamingZip") && xlsxStream.includes("createDeflateRaw"), "The export must stream a real XLSX workbook."],
  [!exportRoute.includes('.in("raw_event_id"'), "The full export must not issue one processing query per raw-event ID batch."],
  [exportRoute.includes("rows.length <= 5_000") && exportRoute.includes("enrichProcessingHistory"), "Large exports must skip the unbounded processing-history scan."],
  [exportRoute.includes("chunks(remainingOffsets, 8)") && exportRoute.includes("exportCutoff"), "Full exports must load stable raw-event pages concurrently."],
  [exportButton.includes("Preparing Excel") && exportButton.includes('role="alert"'), "The export must show progress and a usable error."],
  [mapping.includes("existingByProfile") && mapping.includes("config.tables"), "Mapping filters must validate the real People or Workforce profile rather than trusting a stale enrolment link."],
  [resolver.includes('match: "serial"') && resolver.includes('match: "terminal"') && resolver.includes('match: "network"'), "Location resolution must support serial, terminal, and network fallbacks."]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("Raw Punches report verification passed.");
