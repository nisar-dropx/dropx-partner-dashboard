import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actions = read("src/app/field-executive/actions.ts");
const contacts = read("src/lib/workforce-contact-availability.ts");
const identity = read("src/lib/onboarding-identity.ts");
const migration = read("supabase/migrations/20261009015557_allow_shared_mobile_numbers_across_people.sql");
const opsPage = read("src/components/ops-work-force-register-page.tsx");
const sharedPage = read("src/components/field-executive-page-content.tsx");

const checks = [
  [!actions.includes("allowDuplicateMobile") && !actions.includes("allowDifferentWorkforceDesignation"), "Create, update, and bulk import must not opt any People register into mobile-identity blocking."],
  [!actions.includes("evaluateOnboardingIdentity") && !actions.includes("identityExceptionEventMetadata"), "Create and bulk import must not depend on the retired phone-identity RPC or metadata."],
  [contacts.includes('message: "Mobile number format is valid."') && contacts.includes("checkWorkforceEmailAvailability(params)"), "Shared mobiles must bypass identity lookup while retaining format and email validation."],
  [!contacts.includes('mobileStatus.status === "taken"') && !contacts.includes('column: "mobile",'), "Contact validation must not query or reject a mobile number that belongs to another People ID."],
  [contacts.includes('if (emailStatus.status === "taken") throw new Error(emailStatus.message);'), "Email uniqueness must remain enforced."],
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
