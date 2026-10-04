import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actions = read("src/app/field-executive/actions.ts");
const contacts = read("src/lib/workforce-contact-availability.ts");
const migration = read("supabase/migrations/20261004191046_allow_duplicate_workforce_mobile_numbers.sql");
const opsPage = read("src/components/ops-work-force-register-page.tsx");
const sharedPage = read("src/components/field-executive-page-content.tsx");

const workforceDuplicateOptIns = actions.match(/allowDuplicateMobile:\s*table === "workforce"/g) ?? [];
const checks = [
  [workforceDuplicateOptIns.length === 4, "Create, update, and bulk import must all opt canonical Workforce into duplicate-mobile support."],
  [contacts.includes("params.allowDuplicateMobile") && contacts.includes("checkWorkforceEmailAvailability(params)"), "Duplicate-mobile support must bypass only the mobile lookup while retaining email validation."],
  [contacts.includes('if (emailStatus.status === "taken") throw new Error(emailStatus.message);'), "Email uniqueness must remain enforced."],
  [actions.includes('/^\\d{10}$/.test(mobile)') && actions.includes('/^\\d{6,15}$/.test(mobile)'), "Single-add and bulk mobile format validation must remain in place."],
  [actions.includes("duplicated in the Excel file") && actions.includes("is already registered"), "Bulk DropX ID duplicate checks must remain in place."],
  [migration.includes("jsonb_array_length(exact_matches) > 0 and tg_table_name <> 'workforce'"), "The database identity trigger must exempt only Workforce from exact mobile-match rejection."],
  [migration.includes("if tg_table_name <> 'workforce' then") && migration.includes("identity_exception_required := true"), "Non-Workforce protection and different-designation lifecycle metadata must remain."],
  [opsPage.includes("FieldExecutivePageContent") && sharedPage.includes("createFieldExecutive"), "Ops and Dashboard must continue to share the same Workforce add action."],
  [actions.includes("Bulk workforce onboarding is not available in OpsPulse"), "This change must not silently enable the intentionally unavailable Ops bulk flow."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Workforce duplicate-mobile verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Workforce duplicate-mobile policy verified.");
