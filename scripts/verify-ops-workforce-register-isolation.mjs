import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/components/ops-work-force-register-page.tsx");
const people = read("src/components/ops-workforce-people.tsx");
const shared = read("src/components/field-executive-page-content.tsx");
const canonicalPeople = read("src/lib/canonical-workforce-people.ts");
const actions = read("src/app/field-executive/actions.ts");
const route = read("src/app/ops-pulse/work-force-register/page.tsx");
const helperRoute = read("src/app/ops-pulse/work-force-register/helpers/page.tsx");
const vendorRoute = read("src/app/ops-pulse/work-force-register/vendors/page.tsx");
const profiles = read("src/lib/workforce-profiles.ts");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const permissions = read("src/components/permission-matrix.tsx");
const accessSurface = read("src/lib/access-surface.ts");
const middleware = read("src/middleware.ts");
const permissionMigration = read("supabase/migrations/20260903052324_isolate_opspulse_workforce_register.sql");

const opsCodesMatch = accessSurface.match(/export const opsAccessPageCodes = \[([\s\S]*?)\] as const;/);
const opsCodes = opsCodesMatch?.[1] ?? "";
const checks = [
  [page.includes('pageCode="delivery_associates"') && shared.includes('requirePagePermission(pageCode, "access")') && shared.includes('canOnboardDesignation'), "OpsPulse register must use only the canonical Workforce category and permission."],
  [page.includes('returnPath="/work-force-register"') && route.includes("OpsWorkforceRegisterPage"), "The live OpsPulse route must render the isolated Workforce flow."],
  [!["Independent Contractors", "Helpers", "Vendors"].some((label) => page.includes(label)), "The OpsPulse Workforce screen must not expose contractor, helper or vendor choices."],
  [helperRoute.includes('redirect("/work-force-register")') && vendorRoute.includes('redirect("/work-force-register")'), "Legacy helper and vendor OpsPulse URLs must return to Workforce."],
  [profiles.includes('return { ...nonEmployeeProfileConfigs.field_executive, route };'), "OpsPulse submissions must resolve to the field-executive Workforce profile configuration."],
  [navigation.includes('{ code: "delivery_associates", label: "Workforce Register"') && !navigation.includes('{ code: "contractors", label: "Work Force Register"'), "OpsPulse navigation must authorize the Workforce register, not Independent Contractors."],
  [permissions.includes('{ key: "workforce_register", label: "Workforce Register", codes: ["delivery_associates"] }'), "OpsPulse role setup must expose only Workforce Register permissions."],
  [opsCodes.includes('"delivery_associates"') && !/"contractors"|"workers"|"vendors"/.test(opsCodes), "Independent contractor, helper and vendor pages must not belong to the OpsPulse surface."],
  [!middleware.match(/CLEAN_OPS_ROOTS[^;]+/)?.[0].includes('"/helpers"'), "The standalone Helper register must not be reachable on the OpsPulse host."],
  [permissionMigration.includes("role.product_code = 'operations'") && permissionMigration.includes("page.code in ('contractors', 'workers', 'vendors')"), "Existing Operations-role access must be moved to Workforce without retaining unrelated register grants."],
  [page.includes("FieldExecutivePageContent") && page.includes("OpsWorkforcePeople"), "Ops must reuse Dashboard onboarding and canonical register components."],
  [people.includes("activeOnly: false") && !people.includes("activeOnly: true"), "The Ops Workforce register must include current IDs in every onboarding and active state, including inactive records."],
  [canonicalPeople.includes("migration_state") && /!\s*row\.deleted_at/.test(canonicalPeople) && canonicalPeople.includes('"reclassified", "moved_to_vendor"'), "The all-ID register must still exclude soft-deleted and migrated non-Workforce rows."],
  [shared.includes('accessSurface !== "ops" ? <FieldExecutiveBulkImportPanel') && actions.includes("Bulk workforce onboarding is not available in OpsPulse"), "Bulk upload must be hidden and rejected on Ops."],
  [shared.includes("workforceRegisterLocations(rawLocations, authorization)"), "Ops records must exclude Amazon Now and expand only descendants in location scope."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`OpsPulse Workforce isolation verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("OpsPulse Workforce register isolation verified.");
