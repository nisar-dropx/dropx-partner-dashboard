import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const oneRoute = read("apps/connect/app/api/connect/workforce-payments/route.ts");
const oneBreakup = read("apps/connect/src/components/connect-daily-payment-breakdown.tsx");
const workforcePage = read("src/app/payments/workforce-payouts/page.tsx");
const workforceTable = read("src/components/workforce-payout-table.tsx");

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
assert.match(workforceTable, /aria-expanded=\{expanded\}/, "The Workforce breakup must be keyboard-accessible");
assert.match(workforceTable, /"Breakup"/, "Workforce must expose the daily breakup action");
assert.match(workforceTable, /DropX associate/, "Workforce must identify the registered associate");
assert.match(workforceTable, /Partner ID/, "Workforce must show the mapped partner ID without coupling the shared UI to Amazon");
assert.match(workforceTable, /Partner name/, "Workforce must show the source partner-account name");

console.log("Workforce payment breakup verification passed.");
