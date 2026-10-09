import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-publication-refresh.ts", import.meta.url), "utf8");
const cronSource = readFileSync(new URL("../app/api/cron/workforce-payout-publication-refresh/route.ts", import.meta.url), "utf8");
const bulkUploadSource = readFileSync(new URL("../app/api/payments/workforce-payouts/bulk-upload/route.ts", import.meta.url), "utf8");
const vercel = readFileSync(new URL("../../vercel.json", import.meta.url), "utf8");

test("publication refresh worker claims bounded durable jobs and recalculates a stable worksheet", () => {
  assert.match(source, /workforce_claim_payout_publication_refresh_jobs/);
  assert.match(source, /Math\.max\(1, Math\.min\(100,/);
  assert.match(source, /loadStablePayoutWorksheet/);
  assert.match(source, /workforcePayoutDependencyHash/);
  assert.match(source, /loadWorkforcePayoutRows/);
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
  assert.match(cronSource, /refreshWorkforcePayoutPublicationJobs\(\{ deadlineAtMs, limit: 100 \}\)/);
  assert.match(vercel, /\/api\/cron\/workforce-payout-publication-refresh/);
});
