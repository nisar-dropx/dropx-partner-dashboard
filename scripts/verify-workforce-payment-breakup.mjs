import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const oneRoute = read("apps/connect/app/api/connect/workforce-payments/route.ts");
const oneBreakup = read("apps/connect/src/components/connect-daily-payment-breakdown.tsx");
const workforcePage = read("src/app/payments/workforce-payouts/page.tsx");
const workforceTable = read("src/components/workforce-payout-table.tsx");
const workforcePeriodFilter = read("src/components/workforce-payout-period-filter.tsx");
const workforceFinanceQueue = read("src/components/workforce-finance-queue.tsx");

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
assert.match(workforceTable, /"Breakup"/, "Workforce must expose the period-total breakup action");
assert.match(workforceTable, />Work Days</, "The Workforce payout table must display capture-aware Work Days");
assert.match(workforceTable, />Gross Payment</, "The Workforce payout table must show gross payment");
assert.match(workforceTable, />Gross Deductions</, "The Workforce payout table must show gross deductions");
assert.match(workforceTable, />Net Pay</, "The Workforce payout table must show net pay");
assert.doesNotMatch(workforceTable, /overview-method-|daily-method-/, "The visible worksheet must not render global payment-method columns");
assert.match(workforceTable, /"Attendance Source"/, "The Workforce payout export must identify the attendance source");
assert.match(workforceTable, /DropX associate/, "Workforce must identify the registered associate");
assert.match(workforceTable, /Partner ID/, "Workforce must show the mapped partner ID without coupling the shared UI to Amazon");
assert.match(workforceTable, /Partner name/, "Workforce must show the source partner-account name");
assert.doesNotMatch(workforceTable, /PayoutTableView|VIEW_OPTIONS|aria-pressed/, "Workforce must use one compact totals worksheet instead of multiple dense views");
assert.match(workforceTable, /Export full CSV/, "Workforce must make the full-fidelity export clear");
assert.match(workforceTable, /const tableColumnCount = 10/, "Workforce detail and empty rows must span the compact totals worksheet");
assert.match(workforceTable, /Payment totals[\s\S]*Deduction totals/, "Workforce breakup must show period payment and deduction totals");
assert.match(workforceTable, /row\.productionBreakdown\.filter\(\(item\) => item\.amount !== 0\)/, "Workforce breakup must show only the worker's non-zero payment totals");
assert.doesNotMatch(workforceTable, /row\.dailyBreakdown\.map/, "Workforce breakup must not render day-wise rows");
assert.match(workforceTable, /aria-label="Workforce payout horizontal scrollbar"/, "Workforce must expose an always-visible synchronized horizontal scrollbar");
assert.match(workforceTable, /stickyScrollElement\.scrollLeft = tableWrapElement\.scrollLeft[\s\S]*tableWrapElement\.scrollLeft = stickyScrollElement\.scrollLeft/, "Workforce horizontal scrollbars must stay synchronized");
assert.match(workforceTable, /new ResizeObserver\(updateStickyScroll\)/, "Workforce horizontal scrollbar must react to table size changes");

assert.match(workforcePage, /<WorkforcePayoutPeriodFilter/, "Workforce must use the focused period selector");
assert.match(workforcePeriodFilter, /mode === "monthly"[\s\S]*name="month"/, "Monthly mode must show only its month input");
assert.match(workforcePeriodFilter, /mode === "daily"[\s\S]*name="day"/, "Daily mode must show only its day input");
assert.match(workforcePeriodFilter, /mode === "range"[\s\S]*name="from"[\s\S]*name="to"/, "Range mode must show its from and to inputs");
assert.match(workforceTable, /scrollTo\(\{ left: 0, behavior: "smooth" \}\)/, "Opening a breakup from a horizontally scrolled row must reveal its left-aligned details");
assert.doesNotMatch(workforcePage, /Live estimate worksheet|Only workforce in your allocated locations|Calculate provider production/, "Workforce payout top copy must stay compact");
assert.doesNotMatch(workforceFinanceQueue, /Frozen associate amounts from Workforce/, "Confirmed payroll must not repeat the workflow explainer");

console.log("Workforce payment breakup verification passed.");
