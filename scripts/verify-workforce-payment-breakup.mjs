import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const oneRoute = read("apps/connect/app/api/connect/workforce-payments/route.ts");
const oneBreakup = read("apps/connect/src/components/connect-daily-payment-breakdown.tsx");
const workforcePage = read("src/app/payments/workforce-payouts/page.tsx");
const workforceTable = read("src/components/workforce-payout-table.tsx");
const workforcePeriodFilter = read("src/components/workforce-payout-period-filter.tsx");

assert.match(oneRoute, /provider_employee_name/, "DropX One must return the Amazon associate name");
assert.match(oneRoute, /const deliveries = Number\(row\.total_delivery/, "Delivery must use the combined total_delivery count");
assert.doesNotMatch(oneRoute, /label:\s*["']SWA/, "SWA must not be exposed as a separate payment line");
assert.doesNotMatch(oneRoute, /SWA_COD|SWA_PREPAID/, "SWA COD and prepaid must not introduce separate rate logic");

assert.match(oneBreakup, /\["delivery", "c_return", "mfn", "mfn_return"\]/, "DropX One must keep the four requested payment categories");
assert.match(oneBreakup, /DropX associate/, "DropX One must identify the registered associate");
assert.match(oneBreakup, /Partner ID/, "DropX One must show the mapped partner ID without coupling the shared UI to Amazon");
assert.match(oneBreakup, /Partner name/, "DropX One must show the source partner-account name");

assert.match(workforcePage, /dailyBreakdown/, "Workforce must calculate a daily payment breakup");
assert.match(workforcePage, /source === "total_delivery"/, "Workforce must support the combined Delivery metric");
assert.match(workforcePage, /"C-return"/, "Workforce must use the requested C-return label");
assert.match(workforcePage, /"MFN return"/, "Workforce must use the requested MFN return label");
assert.match(workforcePage, /summarizeWorkDays/, "Workforce must summarize capture-aware attendance as Work Days");
assert.match(workforcePage, /workDayUnits:\s*calculation\.attendanceUnit/, "Direct payout Work Days must use canonical attendance units");
assert.match(workforcePage, /paymentMethodBreakdown/, "Workforce must subtotal each mapped payment method separately");
assert.match(workforcePage, /Shipment data unavailable/, "Providerless shipment attendance must be shown as unavailable instead of zero");
assert.match(workforcePage, /const lineMap = new Map[\s\S]*for \(const day of dailyBreakdown\) for \(const line of day\.lines\)/, "Existing component units, rates and amounts must remain in the payout breakup");
assert.match(workforceTable, /aria-expanded=\{expanded\}/, "The Workforce breakup must be keyboard-accessible");
assert.match(workforceTable, /"Breakup"/, "Workforce must expose the daily breakup action");
assert.match(workforceTable, />Work Days</, "The Workforce payout table must display capture-aware Work Days");
assert.match(workforceTable, /paymentMethodColumns\.map/, "The Workforce payout table must render a separate amount column for every mapped payment method");
assert.match(workforceTable, /"Attendance Source"/, "The Workforce payout export must identify the attendance source");
assert.match(workforceTable, /DropX associate/, "Workforce must identify the registered associate");
assert.match(workforceTable, /Partner ID/, "Workforce must show the mapped partner ID without coupling the shared UI to Amazon");
assert.match(workforceTable, /Partner name/, "Workforce must show the source partner-account name");
assert.match(workforceTable, /useState<PayoutTableView>\("overview"\)/, "Workforce must open in the understandable overview view");
assert.match(workforceTable, /label: "Overview"[\s\S]*label: "Production"[\s\S]*label: "Deductions"[\s\S]*label: "All details"/, "Workforce must provide focused worksheet views");
assert.match(workforceTable, /aria-pressed=\{view === option\.id\}/, "Workforce worksheet views must expose their selected state");
assert.match(workforceTable, /Export full CSV/, "Workforce must make the full-fidelity export clear");
assert.match(workforceTable, /const tableColumnCount = view === "overview"[\s\S]*productionColumns\.length \* 3/, "Workforce detail and empty rows must span the active worksheet view");
assert.match(workforceTable, /payout-daily-production/, "Workforce daily breakup must condense production lines instead of repeating the full worksheet");

assert.match(workforcePage, /<WorkforcePayoutPeriodFilter/, "Workforce must use the focused period selector");
assert.match(workforcePeriodFilter, /mode === "monthly"[\s\S]*name="month"/, "Monthly mode must show only its month input");
assert.match(workforcePeriodFilter, /mode === "daily"[\s\S]*name="day"/, "Daily mode must show only its day input");
assert.match(workforcePeriodFilter, /mode === "range"[\s\S]*name="from"[\s\S]*name="to"/, "Range mode must show its from and to inputs");
assert.match(workforceTable, /scrollTo\(\{ left: 0, behavior: "smooth" \}\)/, "Opening a breakup from a horizontally scrolled row must reveal its left-aligned details");

console.log("Workforce payment breakup verification passed.");
