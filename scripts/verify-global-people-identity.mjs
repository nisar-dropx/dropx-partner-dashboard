import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/20261006134250_global_people_identity_uniqueness.sql");
const actions = read("src/app/field-executive/actions.ts");
const sharedPage = read("src/components/field-executive-page-content.tsx");
const dashboardPage = read("src/app/workforce/page.tsx");
const opsPage = read("src/components/ops-work-force-register-page.tsx");
const biometricIds = read("src/lib/biometric/ids.ts");
const biometricEnrolments = read("src/lib/biometric/enrolments.ts");

const normalizedSql = migration.replace(/\s+/g, " ").toLowerCase();
const triggerTables = ["employees", "contractors", "workforce", "helpers", "vendors", "workforce_helpers", "workforce_pickers"];
const hasDynamicTriggerInstaller = /create\\s+trigger\\s+[^;]+?\\s+on\\s+(?:public\\.)?%i\\b/is.test(migration);

function hasIdentityTrigger(table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directTrigger = new RegExp(`create\\s+trigger\\s+[^;]+?\\s+on\\s+(?:public\\.)?${escaped}\\b`, "is").test(migration);
  const tableInDynamicInstaller = new RegExp(`['\"]${escaped}['\"]`, "i").test(migration);
  return directTrigger || (hasDynamicTriggerInstaller && tableInDynamicInstaller);
}

const hasDropxNormalizer = (
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.|private\.)?\w*normalize\w*dropx\w*/i.test(migration)
  && /upper\s*\(/i.test(migration)
  && /regexp_replace\s*\(/i.test(migration)
);
const hasBiometricNormalizer = (
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.|private\.)?\w*normalize\w*biometric\w*/i.test(migration)
  && /ltrim\s*\(/i.test(migration)
  && /(?:\[0-9\]|\\d|\[:digit:\])/.test(migration)
);
const hasRegistryUniqueness = (
  /(?:normalized_(?:value|id)|identity_(?:key|value))/.test(normalizedSql)
  && /(?:primary\s+key|unique\s+(?:index|\())/.test(normalizedSql)
);
const hasLockedCrossTableGuard = normalizedSql.includes("pg_advisory_xact_lock");
const hasGlobalIdentityGuard = (
  normalizedSql.includes("dropx_id")
  && normalizedSql.includes("biometric_id")
  && normalizedSql.includes("company_id")
  && (hasRegistryUniqueness || hasLockedCrossTableGuard)
  && /raise\s+exception/.test(normalizedSql)
);

const checks = [
  [hasDropxNormalizer, "The migration must normalize DropX IDs across case and whitespace before checking uniqueness."],
  [hasBiometricNormalizer, "The migration must normalize numeric biometric IDs, including leading zeroes, before checking uniqueness."],
  [hasGlobalIdentityGuard, "The migration must enforce one company-wide normalized identity key for both DropX and biometric IDs."],
  [triggerTables.every(hasIdentityTrigger), `The global identity guard must be attached to: ${triggerTables.join(", ")}.`],
  [
    !actions.includes("peopleIdentityForDualRole")
      && !actions.includes("peopleIdentity?.dropxId")
      && !actions.includes("peopleIdentity?.biometricId")
      && !actions.includes("shared_dropx_id")
      && !actions.includes("shared_biometric_id"),
    "Workforce creation must not reuse DropX or biometric IDs from an existing People profile."
  ],
  [
    actions.includes("generateConfiguredWorkerId")
      && actions.includes("generateConfiguredBiometricId"),
    "Workforce creation must continue generating its own DropX and biometric IDs."
  ],
  [
    dashboardPage.includes("FieldExecutivePageContent")
      && opsPage.includes("FieldExecutivePageContent")
      && sharedPage.includes('action={createFieldExecutive}')
      && sharedPage.includes('from "@/app/field-executive/actions"'),
    "OpsPulse and Dashboard must continue using the same createFieldExecutive onboarding action."
  ],
  [
    biometricIds.includes('return text.replace(/^0+(?=\\d)/, "");')
      && !biometricIds.includes("BigInt(")
      && !biometricIds.includes("return Number(text)"),
    "Biometric ID generation must preserve long decimal IDs as canonical strings without precision loss."
  ],
  [
    biometricEnrolments.indexOf("const existingResult") < biometricEnrolments.indexOf("const deactivation")
      && !biometricEnrolments.includes(".limit(50)"),
    "Biometric reassignment must validate conflicts before deactivating the current enrolment and without an arbitrary 50-row cap."
  ]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Global People identity verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Global People identity uniqueness verified.");
