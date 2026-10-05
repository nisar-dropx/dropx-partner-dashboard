import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/app/payments/workforce-payouts/page.tsx");
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
  [page.includes('currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts"') && page.includes('requirePagePermission(pageCode, "access")') && page.includes('pageCode={pageCode}'), "The shared page must enforce a separate Ops grant while preserving the Dashboard grant."],
  [page.includes("loadWorkforcePayoutRows(companyId, authorization, period.fromDate, period.toDate)") && payouts.includes("authorization.hasAllLocationAccess") && payouts.includes("authorization.locationScopeIds") && payouts.includes("allowed.has(row.station_id)"), "Workforce payout rows must stay within the signed-in user's assigned locations."],
  [helpers.includes("authorization.hasAllLocationAccess") && helpers.includes("authorization.locationScopeIds") && helpers.includes("allowedLocationIds.has(String(allocation.station_id))"), "Helper payout rows must stay within the signed-in user's assigned locations."],
  [page.includes('audience === "helpers"') && page.includes("loadHelperPayoutRows"), "The mirrored page must retain both Workforce and Helpers tabs."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Ops Workforce Payouts mirror verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Ops Workforce Payouts mirror verified.");
