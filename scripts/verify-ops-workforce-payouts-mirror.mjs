import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/app/payments/workforce-payouts/page.tsx");
const loading = read("src/app/payments/workforce-payouts/loading.tsx");
const payoutTable = read("src/components/workforce-payout-table.tsx");
const paymentHistory = read("src/components/workforce-payout-payment-history-button.tsx");
const paymentHistoryRoute = read("src/app/api/payments/workforce-payouts/payment-history/route.ts");
const bankFileRoute = read("src/app/api/payments/workforce-payouts/bank-file/route.ts");
const bankRedownloadRoute = read("src/app/api/payments/workforce-payouts/bank-file/re-download/route.ts");
const bankResponseRoute = read("src/app/api/payments/workforce-payouts/bank-response/route.ts");
const paymentStatusRoute = read("src/app/api/payments/workforce-payouts/payment-status/route.ts");
const payouts = read("src/lib/workforce-payout-loader.ts");
const helpers = read("src/lib/helper-payout-loader.ts");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const permissions = read("src/components/permission-matrix.tsx");
const accessSurface = read("src/lib/access-surface.ts");
const accessPages = read("src/lib/access-pages.ts");
const middleware = read("src/middleware.ts");
const migration = read("supabase/migrations/20261001181320_ops_workforce_payouts_access.sql");

const opsCodes = accessSurface.match(/export const opsAccessPageCodes = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const workforceRegisterPosition = navigation.indexOf('{ code: "delivery_associates", label: "Workforce Register"');
const workforcePayoutPosition = navigation.indexOf('{ code: "ops_workforce_payouts", label: "Workforce Payouts"');
const rosteringPosition = navigation.indexOf('{ code: "ops_rostering", label: "Rostering"');

const checks = [
  [middleware.includes('"/payments/workforce-payouts"'), "Ops middleware must allow the shared workforce-payout route."],
  [workforceRegisterPosition >= 0 && workforcePayoutPosition > workforceRegisterPosition && workforcePayoutPosition < rosteringPosition, "Ops navigation must place Workforce Payouts immediately after Workforce Register."],
  [opsCodes.includes('"ops_workforce_payouts"'), "The Ops payout permission must admit properly granted users to the Ops surface."],
  [permissions.includes('{ key: "ops_workforce_payouts", label: "Workforce Payouts", codes: ["ops_workforce_payouts"] }'), "Ops role setup must expose Workforce Payouts with the standard View/Add/Edit controls."],
  [accessPages.includes('{ code: "ops_workforce_payouts", name: "Workforce & Helper Payments"') && migration.includes("'ops_workforce_payouts'"), "The Ops payout permission must be provisioned for every company without automatic non-owner grants."],
  [page.includes("const accessSurface = currentAdminAccessSurface()") && page.includes('accessSurface === "ops" ? "ops_workforce_payouts" : "workforce_payouts"') && page.includes('requirePagePermission(pageCode, "access")') && page.includes('pageCode={pageCode}'), "The shared page must enforce a separate Ops grant while preserving the Dashboard grant."],
  [page.includes("loadWorkforcePayoutRows(companyId, authorization, period.fromDate, period.toDate)") && payouts.includes("authorization.hasAllLocationAccess") && payouts.includes("authorization.locationScopeIds") && payouts.includes("allowed.has(row.station_id)"), "Workforce payout rows must stay within the signed-in user's assigned locations."],
  [helpers.includes("authorization.hasAllLocationAccess") && helpers.includes("authorization.locationScopeIds") && helpers.includes("allowedLocationIds.has(String(allocation.station_id))"), "Helper payout rows must stay within the signed-in user's assigned locations."],
  [page.includes('audience === "helpers"') && page.includes("loadHelperPayoutRows"), "The mirrored page must retain both Workforce and Helpers tabs."],
  [loading.includes("WorkforcePayoutWorkspaceLoading"), "Ops and Dashboard must share the payout loading skeleton."],
  [payoutTable.includes('className="payout-search-strip"') && payoutTable.includes('className="payout-filter-panel"') && payoutTable.includes('label="Location"') && payoutTable.includes('label="Designation"') && payoutTable.includes('label="Provider"') && payoutTable.includes('label="Payment method"') && payoutTable.includes('label="Mapping status"') && payoutTable.includes('label="Status"'), "The shared sleek UI must keep search and every payout filter directly visible."],
  [payoutTable.includes('{canEdit ? <div className="payout-global-actions">') && payoutTable.includes("Export full CSV"), "The complete global action group, including export, must require payout edit permission."],
  [payoutTable.includes("canViewPaymentHistory && row.reviewSubjectId && row.locationId && row.paymentSummary") && payoutTable.includes("canManageStatus={canProcessPayments}"), "Monthly row payment history must remain viewable while status management stays edit-gated."],
  [paymentHistoryRoute.includes('hasPermission(authorization, pageCode, "access")') && paymentHistoryRoute.includes("authorization.locationScopeIds.some") && paymentHistoryRoute.includes("=== stationId") && paymentHistoryRoute.includes("authorization.hasAllLocationAccess") && paymentHistoryRoute.includes("? holdQuery") && paymentHistoryRoute.includes("Promise.resolve({ data: [], error: null })"), "Payment history must require page access, enforce account locations, and hide profile-wide hold remarks from scoped viewers."],
  [paymentHistory.includes("canManageStatus && entry.redownloadable") && paymentHistory.includes("canManageStatus ? <td>") && !paymentHistory.includes("Mark on hold") && payoutTable.includes("canManageIndividualHold ? <WorkforcePayoutBulkHold"), "Payment-history status mutations and bank-file re-download must remain manage-permission-only, while individual hold stays in the expanded row."],
  [page.includes('const canUsePaymentActions = accessSurface === "ops"') && page.includes('|| hasPermission(authorization, "payment_process", "edit")') && page.includes("&& canUsePaymentActions"), "Ops payout editors must receive payment actions without depending on the Finance-only Payment Process page."],
  [[bankFileRoute, bankRedownloadRoute, bankResponseRoute, paymentStatusRoute].every((route) => route.includes('accessSurface === "ops" || hasPermission(authorization, "payment_process", "edit")') && route.includes('!canUsePaymentActions')), "Every sensitive payment endpoint must mirror the Ops page-edit exception while preserving the non-Ops Payment Process gate."],
  [[bankFileRoute, bankRedownloadRoute, bankResponseRoute, paymentStatusRoute].every((route) => route.includes("authorization.hasAllLocationAccess")), "Profile-wide bank and status mutations must retain their all-location safety gate."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Ops Workforce Payouts mirror verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Ops Workforce Payouts mirror verified.");
