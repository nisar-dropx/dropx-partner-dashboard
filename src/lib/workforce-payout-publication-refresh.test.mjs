import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { noStoreFetch } from "./timeout-fetch.ts";

const source = readFileSync(new URL("./workforce-payout-publication-refresh.ts", import.meta.url), "utf8");
const supabaseAdminSource = readFileSync(new URL("./supabase-admin.ts", import.meta.url), "utf8");
const cronSource = readFileSync(new URL("../app/api/cron/workforce-payout-publication-refresh/route.ts", import.meta.url), "utf8");
const bulkUploadSource = readFileSync(new URL("../app/api/payments/workforce-payouts/bulk-upload/route.ts", import.meta.url), "utf8");
const vercel = readFileSync(new URL("../../vercel.json", import.meta.url), "utf8");

test("service-role Supabase requests always bypass the Next.js data cache", async () => {
  let receivedInit;
  const fetcher = noStoreFetch(async (_input, init) => {
    receivedInit = init;
    return Response.json({ ok: true });
  });

  const response = await fetcher("https://example.supabase.co/rest/v1/rpc/claim", {
    method: "POST",
    cache: "force-cache"
  });

  assert.equal(response.status, 200);
  assert.equal(receivedInit.method, "POST");
  assert.equal(receivedInit.cache, "no-store");
  assert.match(supabaseAdminSource, /fetch:\s*timeoutFetch\(noStoreFetch\(\)\)/);
});

test("publication refresh worker claims bounded durable jobs and recalculates a stable worksheet", () => {
  assert.match(source, /workforce_claim_payout_publication_refresh_jobs/);
  assert.match(source, /Math\.max\(1, Math\.min\(100,/);
  assert.match(source, /loadStablePayoutWorksheet/);
  assert.match(source, /workforcePayoutDependencyHash/);
  assert.match(source, /loadWorkforcePayoutRows/);
});

test("publication refresh worker can claim an exact selected Workforce period without changing canonical claims", () => {
  assert.match(source, /workforce_claim_selected_payout_publication_refresh_jobs/);
  assert.match(source, /p_company_id: target\.companyId/);
  assert.match(source, /p_workforce_ids: target\.workforceIds/);
  assert.match(source, /p_period_start: target\.periodStart/);
  assert.match(source, /p_period_end: target\.periodEnd/);
  assert.match(source, /requires a company, Workforce IDs, period start, and period end together/i);
  assert.match(source, /MAX_TARGETED_WORKFORCE_IDS\s*=\s*10_000/);
  assert.match(source, /requires valid company and Workforce IDs/);
  assert.doesNotMatch(source, /\.in\("workforce_id", target\.workforceIds\)/);
  assert.match(source, /workforce_claim_payout_publication_refresh_jobs/);
  assert.match(source, /p_batch_id: input\.batchId \?\? null/);
});

test("transient claim failures are retried a bounded number of times", () => {
  assert.match(source, /MAX_CLAIM_REQUEST_ATTEMPTS\s*=\s*3/);
  assert.match(source, /isTransientClaimError\(lastError\)/);
  assert.match(source, /attempt === MAX_CLAIM_REQUEST_ATTEMPTS/);
  assert.match(source, /await waitForClaimRetry\(attempt\)/);
  assert.match(source, /result\.claimRetries \+= Math\.max\(0, claimed\.attempts - 1\)/);
  assert.match(source, /code: "claim_failed"/);
  assert.match(source, /could not be claimed after.*attempt/s);
});

test("publication refresh jobs are leased just in time within a route deadline", () => {
  assert.match(source, /while \(result\.claimed < maxJobs\)/);
  assert.match(source, /p_limit: 1/);
  assert.match(source, /NEXT_CLAIM_RUNTIME_RESERVE_MS/);
  assert.match(source, /deadlineAtMs/);
  assert.match(source, /await processClaimedJobs\(result, jobs, input\)/);
  assert.match(source, /remaining published payout updates stay queued for the next worker/i);
  assert.match(cronSource, /deadlineAtMs.*maxDuration - 60/s);
  assert.match(bulkUploadSource, /publicationRefreshDeadlineAtMs.*maxDuration - 60/s);
  assert.doesNotMatch(source, /p_limit:\s*Math\.max\(1, Math\.min\(100/);
});

test("publication refresh worker builds immutable snapshots and applies a new database revision", () => {
  assert.match(source, /buildWorkforcePayoutPublicationSnapshot/);
  assert.match(source, /workforcePayoutPublicationSnapshotHash/);
  assert.match(source, /workforce_apply_payout_publication_input_revisions/);
  assert.match(source, /p_expected_dependency_hash: worksheet\.dependencyHash/);
});

test("failed refresh work is lease-released through the bounded retry RPC", () => {
  assert.match(source, /workforce_fail_payout_publication_refresh_jobs/);
  assert.match(source, /claim_token: job\.claim_token/);
  assert.match(source, /retrying/);
  assert.match(source, /failed\/dead-letter state/i);
  assert.doesNotMatch(source, /\.update\(\{\s*status: "pending"/);
});

test("claim-preamble dead letters are surfaced in operational results", () => {
  assert.match(source, /const claimStartedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(source, /\.gte\("failed_at", claimStartedAt\)/);
  assert.match(source, /crashExpiredIds/);
  assert.match(source, /result\.failed \+= crashExpiredIds\.length/);
  assert.match(source, /expired final-attempt refresh job/i);
});

test("missing rows become zero revisions only for safe input-only publications", () => {
  assert.match(source, /buildClearedInputOnlyWorkforcePayoutPublicationSnapshot/);
  assert.match(source, /latestByIdentity/);
  assert.match(source, /prior publication was not a safe input-only row to clear/i);
});

test("a protected recurring worker drains publication refresh jobs after request failures", () => {
  assert.match(cronSource, /process\.env\.CRON_SECRET/);
  assert.match(cronSource, /authorization/);
  assert.match(cronSource, /fetchCache\s*=\s*"force-no-store"/);
  assert.match(cronSource, /revalidate\s*=\s*0/);
  assert.match(cronSource, /refreshWorkforcePayoutPublicationJobs\(\{ deadlineAtMs, limit: 100 \}\)/);
  assert.match(vercel, /\/api\/cron\/workforce-payout-publication-refresh/);
});

test("the worker and cron expose queue health and fail a stalled ready queue observably", () => {
  assert.match(source, /remainingReady: number/);
  assert.match(source, /remainingUnfinished: number/);
  assert.match(source, /queueStatusChecked: boolean/);
  assert.match(source, /if \(target\) return/);
  assert.match(source, /status\.eq\.pending,next_attempt_at\.lte/);
  assert.match(source, /status\.eq\.processing,claimed_at\.lt/);
  assert.match(source, /code: "queue_status_failed"/);
  assert.match(cronSource, /result\.remainingReady > 0 && result\.completed === 0/);
  assert.match(cronSource, /status: degraded \? 503 : 200/);
  assert.match(cronSource, /console\.warn\(JSON\.stringify\(log\)\)/);
  assert.match(cronSource, /console\.info\(JSON\.stringify\(log\)\)/);
  assert.match(cronSource, /workforce_payout_publication_refresh_failed/);
});
