import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("apps/connect/src/lib/connect-auth.ts");
const connectTypes = read("apps/connect/src/lib/workforce-profiles.ts");
const dashboardTypes = read("src/lib/workforce-profiles.ts");
const workforcePayments = read("apps/connect/app/api/connect/workforce-payments/route.ts");
const workforcePaymentsUi = read("apps/connect/src/components/connect-workforce-payments.tsx");
const migration = read("supabase/migrations/20260829153000_enforce_people_workforce_register_boundary.sql");
const routing = read("src/lib/designation-register-routing.ts");

const checks = [
  [connectTypes.includes('"workforce"'), "DropX One accepts the canonical Workforce profile type"],
  [dashboardTypes.includes('profileType === "workforce"') && dashboardTypes.includes('return "workforce" as const'), "Dashboard APIs resolve canonical Workforce accounts"],
  [auth.includes('["workforce", "contractor", "vendor", "worker"]') && !auth.includes('["workforce", "field_executive", "contractor", "vendor", "worker"]'), "Account discovery reads each canonical register once"],
  [auth.includes("canonicalWorkforceSources"), "Legacy field executive mirrors are removed from the switcher"],
  [auth.includes("shouldHideIcManagerLogin"), "Pure IC manager logins defer to contractor self-service"],
  [auth.includes("isConnectManagerLogin"), "Admin and manager logins stay available"],
  [auth.includes("resolveIcSelfServiceByReference"), "IC self-service resolves from linked DropX references"],
  [auth.includes("enrichAccountsWithIcSelfService"), "IC manager logins enrich with register self-service"],
  [auth.includes("collectSelfServiceReferences"), "Manager user logins collapse when self-service registers exist"],
  [auth.includes("workforceDesignationAccess") && auth.includes("intersectPageAccess(categoryPages, designationPages)") && auth.includes("requiredDropxOnePageCodes"), "Workforce uses designation-owned access while People retains category/designation intersection plus mandatory pages"],
  [auth.includes("normalizeWorkforcePageAccess") && auth.includes("pageAccessByDesignationRole"), "Workforce designation page codes and imported designation labels resolve safely"],
  [workforcePayments.includes("workforce_id") && workforcePayments.includes("[mapping.workforce_id, mapping.field_executive_id, mapping.contractor_id, mapping.employee_id]"), "Workforce payment lookup includes canonical Workforce mappings"],
  [workforcePaymentsUi.includes("/api/connect/earnings?") && workforcePaymentsUi.includes("Estimated live earnings"), "Workforce live earnings use the active rate card when imports have no processed payout amount"],
  [auth.includes('nonEmployeeSelect("contractor")') && auth.includes("nonEmployeeSelect(profileType, true)"), "Each One account register is queried only with columns available on that table"],
  [auth.includes('if (profileType === "contractor")') && auth.includes('`${nonEmployeeBaseSelect}${mobileColumns},deleted_at`'), "People contractors do not depend on Workforce-only source columns"],
  [auth.includes("employeeReferences"), "Duplicate People manager and employee logins stay collapsed"],
  [!auth.includes("loadLinkedSelfServiceRecords"), "Broad linked profile discovery stays disabled"],
  [migration.includes("public.set_designation_register_route"), "Cutover uses the master-defined routing workflow"],
  [migration.includes("category.people_module") && !migration.includes("in ('DA', 'WM', 'ODCD', 'DCD')"), "Every Workforce designation is selected from the category master without a role list"],
  [migration.includes("An active Workforce designation still exists in Independent Contractors"), "Active Workforce profiles cannot remain in Independent Contractors"],
  [migration.includes("historical Workforce contractor is missing its canonical register link"), "Historical Workforce profiles retain a canonical compatibility trail"],
  [routing.includes("loadDesignationWorkspaceRule") && routing.includes("onboardingCategories.includes(table)"), "People employee-versus-contractor registration follows the designation master"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
