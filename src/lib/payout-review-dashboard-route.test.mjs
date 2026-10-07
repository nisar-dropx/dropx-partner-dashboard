import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Dashboard exposes payout disputes under an inherited dedicated permission", () => {
  const page = read("../app/payments/disputes/page.tsx");
  const routeActions = read("../app/payments/disputes/actions.ts");
  const desk = read("../components/payout-review-desk.tsx");
  const reviewActions = read("./payout-review-actions.ts");
  const navigation = read("./app-navigation.ts");
  const authorization = read("./authorization.ts");
  const accessPages = read("./access-pages.ts");
  const permissionMatrix = read("../components/permission-matrix.tsx");

  assert.match(page, /requirePagePermission\("workforce_payout_disputes", "access"\)/);
  assert.match(page, /portal="workforce"/);
  assert.match(routeActions, /performPayoutReview\(form, "workforce"\)/);
  assert.match(routeActions, /revalidatePath\("\/payments\/disputes"\)/);
  assert.match(navigation, /code: "workforce_payout_disputes", label: "Disputes", href: "\/payments\/disputes"/);
  assert.match(desk, /'workforce_payout_disputes'/);
  assert.match(reviewActions, /'workforce_payout_disputes'/);
  assert.doesNotMatch(desk, /workforce_adjustments/);
  assert.doesNotMatch(reviewActions, /workforce_adjustments/);
  assert.match(accessPages, /code: "workforce_payout_disputes", name: "Workforce Payout Disputes"/);
  assert.match(
    accessPages,
    /seedTargetPermissionsFromSources\(supabase, companyId, \["workforce_payouts"\], "workforce_payout_disputes"\)/
  );
  assert.match(authorization, /workforce_payouts", "workforce_payout_disputes", "workforce_advances/);
  assert.match(permissionMatrix, /workforce_payouts", "workforce_payout_disputes", "workforce_advances/);
  assert.match(desk, /auth\.hasAllLocationAccess\?null:auth\.locationScopeIds/);
  assert.match(desk, /publication_kind==='worksheet'[\s\S]*?period_start[\s\S]*?period_end[\s\S]*?station_id/);
  assert.match(desk, /legacyLatest=latest\.filter\(p=>p\.publication_kind!=='worksheet'&&p\.payroll_run_id\)/);
  assert.match(desk, /\{legacyLatest\.filter\(/);
  assert.match(page, /role=\{searchParams\.error \? "alert" : "status"\}/);
  assert.match(desk, /decodePayoutReviewReason\(d\.reason\)/);
  assert.match(desk, /visiblePayoutDisputeEvents\(events\.filter/);
  assert.match(desk, /Correct a legacy payroll payout/);
  assert.match(desk, /Worksheet payouts are corrected from Workforce Payouts and published as a new revision/);
  assert.match(desk, /payoutNotificationStatusLabel\(p\.notification_status\)/);
  assert.doesNotMatch(page, /correct published payouts/);
});

test("Ops payout review retains its existing permission and route", () => {
  const page = read("../app/ops-pulse/attendance/payout-review/page.tsx");
  const desk = read("../components/payout-review-desk.tsx");
  const actions = read("./payout-review-actions.ts");

  assert.match(page, /requirePagePermission\('ops_workforce_losses','access'\)/);
  assert.match(page, /portal="ops"/);
  assert.match(desk, /portal==='ops'\?'ops_workforce_losses':'workforce_payout_disputes'/);
  assert.match(actions, /portal==='ops'\?'ops_workforce_losses':'workforce_payout_disputes'/);
});
