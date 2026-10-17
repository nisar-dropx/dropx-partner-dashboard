import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const helper = readFileSync(new URL("./workforce-payout-publication-self-heal.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/payments/workforce-payouts/publication-refresh/route.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../components/workforce-payout-publication-self-heal.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");

test("self-heal recalculates exact scoped rows before calling the ensure RPC", () => {
  assert.match(helper, /loadStablePayoutWorksheet\(\{/);
  assert.match(helper, /loadWorkforcePayoutRows\([\s\S]*?\{ workforceIds \}/);
  assert.match(helper, /authorization\.companyId !== input\.companyId/);
  assert.match(helper, /locationScopeIds[\s\S]*?outside your permitted locations/);
  assert.match(helper, /matching\.length !== 1/);
  assert.match(helper, /!row\.paymentDetailsAvailable/);
  assert.match(helper, /currentTargetAmount: money\(row\.netAmount\)/);
  assert.doesNotMatch(helper, /currentTargetAmount:\s*(?:target|input)\./);
});

test("self-heal uses the source-neutral idempotent database contract", () => {
  assert.match(helper, /rpc\("workforce_ensure_payout_publication_refresh_jobs"/);
  for (const parameter of [
    "p_company_id",
    "p_actor_user_id",
    "p_period_start",
    "p_period_end",
    "p_dependency_hash",
    "p_rows"
  ]) assert.match(helper, new RegExp(`${parameter}:`));
  assert.match(helper, /workforce_id: row\.workforceId/);
  assert.match(helper, /station_id: row\.stationId/);
  assert.match(helper, /current_target_amount: row\.currentTargetAmount/);
  for (const resultKey of [
    "requested",
    "enqueued",
    "already_queued",
    "failed",
    "current",
    "missing_publication",
    "mapping_unlocked"
  ]) assert.match(helper, new RegExp(resultKey));
});

test("publication refresh endpoint requires a real editor and validates an exact full-month selection", () => {
  assert.match(route, /authorization\.readOnly \|\| !hasPermission\(authorization, pageCode, "edit"\)/);
  assert.match(route, /completeCalendarMonth\(periodStart, periodEnd\)/);
  assert.match(route, /MAX_WORKFORCE_PAYOUT_PUBLICATION_SELF_HEAL_ROWS/);
  assert.match(route, /new Set\(targets\.map\(identity\)\)\.size !== targets\.length/);
  assert.match(route, /ensureWorkforcePayoutPublicationRefreshJobs\(\{/);
});

test("endpoint drains exact station rows and verifies the queue before success", () => {
  const ensureCalls = [...route.matchAll(/ensureWorkforcePayoutPublicationRefreshJobs\(\{/g)];
  assert.equal(ensureCalls.length, 2);
  assert.match(route, /refreshWorkforcePayoutPublicationJobs\(\{[\s\S]*?payoutRows: targets,[\s\S]*?periodStart,[\s\S]*?periodEnd/);
  assert.doesNotMatch(route, /refreshWorkforcePayoutPublicationJobs\(\{[\s\S]*?workforceIds:/);
  assert.match(route, /refresh\.failed > 0 \|\| refresh\.retrying > 0 \|\| refresh\.staleClaims > 0/);
  assert.match(route, /unresolved\(verification, targets\.length\)/);
  assert.match(route, /missingPublication > 0/);
  assert.match(route, /mappingUnlocked > 0/);
});

test("the invisible client retries transient failures and refreshes verified no-op repairs", () => {
  assert.match(client, /completed = useRef\(new Set<string>\(\)\)/);
  assert.match(client, /completed\.current\.has\(signature\)/);
  assert.match(client, /fetch\("\/api\/payments\/workforce-payouts\/publication-refresh"/);
  assert.match(client, /result\.ok && payload\.ok === true/);
  assert.match(client, /payload\.retryable === true \|\| result\.status === 429 \|\| result\.status >= 500/);
  assert.match(client, /attempt < MAX_ATTEMPTS/);
  assert.match(client, /payload\.progress === true\) router\.refresh\(\)/);
  assert.match(client, /return null;/);
});

test("page discovers exact stable monthly mismatches before payment-state merge", () => {
  const candidates = page.indexOf("const publicationSelfHealRows");
  const merge = page.indexOf("const reviewedPaymentRows");
  assert.ok(candidates > 0 && merge > candidates);
  assert.match(page, /audience === "workforce"[\s\S]*?period\.mode === "monthly"[\s\S]*?canEdit[\s\S]*?!authorization\.readOnly[\s\S]*?!provisional[\s\S]*?!loadError[\s\S]*?!reviewed\.error/);
  assert.match(page, /workforcePayoutPublicationRefreshPending\([\s\S]*?row\.publicationLockState,[\s\S]*?row\.netAmount,[\s\S]*?row\.publicationTargetAmount/);
  assert.match(page, /WorkforcePayoutPublicationSelfHeal[\s\S]*?periodStart=\{period\.fromDate\}[\s\S]*?periodEnd=\{period\.toDate\}/);
});
