import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Dashboard exposes a minimal terminal payout-dispute decision flow", () => {
  const page = read("../app/payments/disputes/page.tsx");
  const routeActions = read("../app/payments/disputes/actions.ts");
  const desk = read("../components/payout-review-desk.tsx");
  const reviewActions = read("./payout-review-actions.ts");
  const navigation = read("./app-navigation.ts");
  const authorization = read("./authorization.ts");
  const accessPages = read("./access-pages.ts");
  const permissionMatrix = read("../components/permission-matrix.tsx");

  assert.match(page, /requirePagePermission\("workforce_payout_disputes", "access"\)/);
  assert.match(routeActions, /performPayoutReview\(form\)/);
  assert.match(routeActions, /revalidatePath\("\/payments\/disputes"\)/);
  assert.match(navigation, /code: "workforce_payout_disputes", label: "Disputes", href: "\/payments\/disputes"/);
  assert.match(desk, /hasPermission\(auth, "workforce_payout_disputes", "edit"\)/);
  assert.match(reviewActions, /requirePagePermission\("workforce_payout_disputes", "edit"\)/);
  assert.match(reviewActions, /workforce_decide_payout_dispute/);
  assert.match(reviewActions, /!\["resolved", "rejected"\]\.includes\(decision\)/);
  assert.match(desk, /name="decision" value="rejected"/);
  assert.match(desk, /name="decision" value="resolved"/);
  assert.doesNotMatch(desk, /Under review \/ reply|Save response|Response<textarea/);
  assert.doesNotMatch(desk, /Legacy payroll corrections|Correct a legacy payroll payout|Published payouts & WhatsApp status/);
  assert.doesNotMatch(reviewActions, /retry_notice|workforce_propose_payout_correction|workforce_review_payout_correction/);
  assert.match(accessPages, /code: "workforce_payout_disputes", name: "Workforce Payout Disputes"/);
  assert.match(
    accessPages,
    /seedTargetPermissionsFromSources\(supabase, companyId, \["workforce_payouts"\], "workforce_payout_disputes"\)/
  );
  assert.match(authorization, /workforce_payouts", "workforce_payout_disputes", "workforce_advances/);
  assert.match(permissionMatrix, /workforce_payouts", "workforce_payout_disputes", "workforce_advances/);
  assert.match(desk, /auth\.hasAllLocationAccess \? null : auth\.locationScopeIds/);
  assert.match(page, /role=\{searchParams\.error \? "alert" : "status"\}/);
  assert.match(desk, /decodePayoutReviewReason\(dispute\.reason\)/);
});

test("Payout disputes are not exposed to the Ops station portal", () => {
  const opsNavigation = read("./ops-pulse/navigation.ts");
  const opsPage = new URL("../app/ops-pulse/attendance/payout-review/page.tsx", import.meta.url);
  const opsActions = new URL("../app/ops-pulse/attendance/payout-review/actions.ts", import.meta.url);

  assert.doesNotMatch(opsNavigation, /Payout disputes|\/attendance\/payout-review/);
  assert.equal(existsSync(opsPage), false);
  assert.equal(existsSync(opsActions), false);
});
