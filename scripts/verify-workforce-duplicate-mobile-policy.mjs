import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actions = read("src/app/field-executive/actions.ts");
const contacts = read("src/lib/workforce-contact-availability.ts");
const identity = read("src/lib/onboarding-identity.ts");
const migration = read("supabase/migrations/20261009015557_allow_shared_mobile_numbers_across_people.sql");
const categoryMigration = read("supabase/migrations/20261124105416_category_scoped_people_contacts.sql");
const opsPage = read("src/components/ops-work-force-register-page.tsx");
const sharedPage = read("src/components/field-executive-page-content.tsx");

const checks = [
  [!actions.includes("allowDuplicateMobile") && !actions.includes("allowDifferentWorkforceDesignation"), "Contact validation must not reinstate the retired designation-based identity exceptions."],
  [!actions.includes("evaluateOnboardingIdentity") && !actions.includes("identityExceptionEventMetadata"), "Create and bulk import must not depend on the retired phone-identity RPC or metadata."],
  [contacts.includes('CONTACT_REGISTERS.filter(item => item.register === params.register)') && actions.includes('register: table,'), "Contact matches must be scoped to the selected category so other categories can reuse email and mobile."],
  [contacts.includes('mobileStatus.status === "taken"') && contacts.includes('column: "mobile",') && contacts.includes('mobile_country_code'), "Duplicate mobiles inside one category must be checked with their country code."],
  [contacts.includes('if (emailStatus.status === "taken") throw new Error(emailStatus.message);'), "Email uniqueness must remain enforced within the selected category."],
  [categoryMigration.includes('people_category_email_unique') && categoryMigration.includes('people_category_mobile_unique') && categoryMigration.includes('pg_advisory_xact_lock'), "The database must enforce both contact rules per category with concurrent-claim protection."],
  [identity.includes("void evaluation;") && !identity.includes("This mobile number is already"), "Onboarding identity evaluation must not reject shared mobile numbers."],
  [identity.includes("return {};") && !identity.includes("identity_exception_required"), "Shared mobile numbers must not create lifecycle exception metadata."],
  [actions.includes('/^\\d{10}$/.test(mobile)') && actions.includes('/^\\d{6,15}$/.test(mobile)'), "Single-add and bulk mobile format validation must remain in place."],
  [actions.includes("duplicated in the Excel file") && actions.includes("is already registered"), "Bulk DropX ID duplicate checks must remain in place."],
  [migration.includes("create or replace function public.enforce_onboarding_mobile_identity()") && migration.includes("return new;"), "The forward migration must make the shared mobile trigger non-blocking."],
  [!migration.includes("evaluate_onboarding_identity") && !migration.includes("raise exception"), "The forward migration must not retain phone-based identity or lifecycle rejection."],
  [!migration.includes("new.identity_exception_") && migration.includes("Preserve every existing field"), "The migration must not rewrite existing Workforce approval or audit state."],
  [opsPage.includes("FieldExecutivePageContent") && sharedPage.includes("createFieldExecutive"), "Ops and Dashboard must continue to share the same Workforce add action."],
  [actions.includes("Bulk workforce onboarding is not available in OpsPulse"), "This change must not silently enable the intentionally unavailable Ops bulk flow."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Workforce duplicate-mobile verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Workforce duplicate-mobile policy verified.");
