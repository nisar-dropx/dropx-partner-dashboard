import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const opsAccess = read("src/app/ops-pulse/access/page.tsx");
const usersPage = read("src/app/users/page.tsx");
const requestActions = read("src/app/payments/requests/actions.ts");
const approvalActions = read("src/app/payments/approvals/actions.ts");
const notifications = read("src/lib/payment-email-notifications.ts");

const checks = [
  [opsAccess.includes('from("company_product_memberships")') && opsAccess.includes('from("people_portal_access_candidates")'), "OpsPulse access must use product memberships and People designations."],
  [!opsAccess.includes('select("id,full_name,email,role_id'), "OpsPulse access must not display the legacy profile role."],
  [usersPage.includes("loadCanonicalUserAccess") && usersPage.includes('from("people_portal_access_candidates")'), "Dashboard identity register must present the canonical People designation."],
  [requestActions.includes('from("company_product_memberships")') && requestActions.includes('in("role_id", roleIds)'), "Initial payment approvers must resolve from active product memberships."],
  [approvalActions.includes('from("company_product_memberships")') && approvalActions.includes('in("role_id", finalRoleIds)'), "Final payment approvers must resolve from active product memberships."],
  [notifications.includes("profilesForProductRoles") && notifications.includes('from("company_product_memberships")'), "Payment notifications must resolve designation members instead of only legacy profile roles."],
  [![opsAccess, usersPage, approvalActions].some((source) => /Cluster Head|Regional Head|Zonal Head/i.test(source)), "Current access screens must not contain legacy designation labels."]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`Canonical access verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Canonical People access and payment routing verified.");
