import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Dashboard and Ops expose the configured three-person payout-correction flow", () => {
  const page = read("../app/payments/disputes/page.tsx");
  const routeActions = read("../app/payments/disputes/actions.ts");
  const desk = read("../components/payout-review-desk.tsx");
  const reviewActions = read("./payout-review-actions.ts");
  const notifications = read("./payout-dispute-notifications.ts");
  const appNotifications = read("./app-notifications.ts");
  const navigation = read("./app-navigation.ts");
  const authorization = read("./authorization.ts");
  const accessPages = read("./access-pages.ts");
  const permissionMatrix = read("../components/permission-matrix.tsx");
  const migration = read("../../supabase/migrations/20261020100000_payout_dispute_processing_workflow.sql");

  // One shared page: Dashboard uses workforce_payout_disputes, Ops Pulse its own grant.
  assert.match(page, /currentAdminAccessSurface\(\) === "ops" \? "ops_workforce_payout_disputes" : "workforce_payout_disputes"/);
  assert.match(page, /requirePagePermission\(pageCode, "access"\)/);
  assert.match(routeActions, /performPayoutReview\(form\)/);
  assert.match(routeActions, /revalidatePath\("\/payments\/disputes"\)/);
  assert.match(navigation, /code: "workforce_payout_disputes", label: "Disputes", href: "\/payments\/disputes"/);
  assert.match(desk, /hasPermission\(auth, pageCode, "edit"\)/);
  assert.match(reviewActions, /const pageCode = ops \? "ops_workforce_payout_disputes" : "workforce_payout_disputes"/);
  assert.match(reviewActions, /requirePagePermissionOrThrow\(pageCode, "edit"\)/);
  assert.match(routeActions, /if \(isRedirectError\(error\)\) throw error/);
  assert.match(reviewActions, /rpc\("workforce_dispute_transition_v2"/);
  assert.match(reviewActions, /p_actor_role_ids: auth\.effectiveRoleIds/);
  assert.match(reviewActions, /p_expected_version: expectedVersion/);
  assert.match(reviewActions, /"propose_correction"/);
  assert.match(reviewActions, /"propose_rejection"/);
  assert.match(reviewActions, /"approve_final"/);
  assert.match(reviewActions, /"claim_processing"/);
  assert.match(reviewActions, /"block_processing"/);
  assert.match(reviewActions, /"complete_processing"/);
  assert.match(reviewActions, /Processing also requires edit permission for Workforce Payouts/);
  assert.match(reviewActions, /hasPermission\(auth, payoutPageCode, "edit"\)/);
  assert.match(reviewActions, /notifyAssociateOfPayoutDispute/);
  assert.match(reviewActions, /Number\.isSafeInteger/);
  assert.match(desk, /name="transition" value="propose_rejection"/);
  assert.match(desk, /name="transition" value="propose_correction"/);
  assert.match(desk, /name="transition" value="approve_final"/);
  assert.match(desk, /name="transition" value="send_back"/);
  assert.match(desk, /name="transition" value="claim_processing"/);
  assert.match(desk, /name="transition" value="complete_processing"/);
  assert.match(desk, /workforce_payout_dispute_workflows/);
  assert.match(desk, /rpc\("workforce_payout_dispute_route_roles"/);
  assert.match(desk, /routeRoleByStage\.get\(`\$\{disputeId\}:\$\{stage\}`\)/);
  assert.match(desk, /Approval routing could not be verified/);
  assert.doesNotMatch(desk, /roleIds\(source, key\)\.some/);
  assert.match(desk, /Settings → Payout Dispute Workflow/);
  assert.match(desk, /A different payout processor must apply the correction/);
  assert.match(desk, /No newer publication for the same person, station and payout period yet/);
  assert.match(desk, /legacy_resolution_unverified/);
  assert.match(desk, /processingStartedAt/);
  assert.match(desk, /Processing blocker:/);
  assert.match(notifications, /workforcePayoutDeepLink/);
  assert.match(notifications, /const route = await payoutRoute/);
  assert.match(notifications, /createAppNotification/);
  assert.match(notifications, /routeOverride: route/);
  assert.doesNotMatch(notifications, /from\("mob_app_notifications"\)|deliverNotificationPush/);
  for (const event of ["advance_request_withdrawn", "payout_dispute_approved", "payout_dispute_rejected", "payout_dispute_resolved"]) {
    assert.match(appNotifications, new RegExp(`"${event}"`));
  }
  assert.match(appNotifications, /ruleResult\.data\?\.route \?\? routeOverride \?\? defaults\.route/);
  assert.doesNotMatch(desk, /Under review \/ reply|Save response|Response<textarea/);
  assert.doesNotMatch(desk, /Legacy payroll corrections|Correct a legacy payroll payout|Published payouts & WhatsApp status/);
  assert.doesNotMatch(reviewActions, /retry_notice|workforce_propose_payout_correction|workforce_review_payout_correction|workforce_dispute_step/);
  assert.match(accessPages, /code: "workforce_payout_disputes", name: "Workforce Payout Disputes"/);
  assert.match(
    accessPages,
    /seedTargetPermissionsFromSources\(supabase, companyId, \["workforce_payouts"\], "workforce_payout_disputes"\)/
  );
  assert.match(
    accessPages,
    /seedTargetPermissionsFromSources\(supabase, companyId, \["workforce_payouts"\], "payment_recoveries", true\)/
  );
  assert.match(authorization, /workforce_payouts", "payment_recoveries", "workforce_payout_disputes", "workforce_advances/);
  assert.match(permissionMatrix, /workforce_payouts", "payment_recoveries", "workforce_payout_disputes", "workforce_advances/);
  assert.match(desk, /auth\.hasAllLocationAccess \? null : auth\.locationScopeIds/);
  assert.match(page, /role=\{searchParams\.error \? "alert" : "status"\}/);
  assert.match(desk, /decodePayoutReviewReason\(dispute\.reason\)/);
  assert.match(migration, /revoke all on function public\.workforce_decide_payout_dispute\(uuid,uuid,uuid,text,text,uuid\[\]\) from service_role/);
  assert.match(migration, /'publication_net_change_verified', true/);
  assert.match(migration, /'field_change_attested_by', p_actor/);
  assert.match(migration, /Processor-applied correction completed; revised publication and net change system-verified/);
  for (const event of ["payout_dispute_approved", "payout_dispute_rejected", "payout_dispute_resolved"]) {
    assert.match(migration, new RegExp(`'${event}'`));
  }
});

test("Payout disputes are not exposed to the Ops station portal", () => {
  const opsNavigation = read("./ops-pulse/navigation.ts");
  const opsPage = new URL("../app/ops-pulse/attendance/payout-review/page.tsx", import.meta.url);
  const opsActions = new URL("../app/ops-pulse/attendance/payout-review/actions.ts", import.meta.url);

  assert.doesNotMatch(opsNavigation, /Payout disputes|\/attendance\/payout-review/);
  assert.equal(existsSync(opsPage), false);
  assert.equal(existsSync(opsActions), false);
});
