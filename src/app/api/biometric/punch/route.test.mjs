import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../../../biometric/page.tsx", import.meta.url), "utf8");

test("biometric punch fallback resolves canonical Helpers", () => {
  assert.match(route, /\["worker", "helpers"\]/);
  assert.match(route, /\["worker", "workforce_helpers"\]/);
});

test("every resolved current mapping is calculated regardless of lifecycle status", () => {
  const start = route.indexOf("const canonicalEnrolmentId");
  const end = route.indexOf("const profileType = enrolment.profile_type", start);
  assert.ok(start >= 0 && end > start, "expected the resolved punch processing block");
  const resolvedPunchBlock = route.slice(start, end);

  assert.match(resolvedPunchBlock, /calculated: true/);
  assert.doesNotMatch(resolvedPunchBlock, /calculated: active/);
  assert.match(resolvedPunchBlock, /if \(!active\)[\s\S]*?alertType: "inactive_worker_punched"/);

  const inactiveStatusBlock = resolvedPunchBlock.slice(
    resolvedPunchBlock.indexOf("if (!active)"),
    resolvedPunchBlock.indexOf("await rebuildAttendanceDay")
  );
  assert.doesNotMatch(inactiveStatusBlock, /return Response/);
  assert.match(resolvedPunchBlock, /await rebuildAttendanceDay\(device\.company_id, canonicalEnrolmentId, punchDate\)/);
});

test("live punch ownership uses the shared priority and ambiguity policy", () => {
  assert.match(route, /hasSameCategoryBiometricDuplicate as hasSameCategoryDuplicate/);
  assert.match(route, /pickPreferredBiometricCandidate/);
  assert.doesNotMatch(route, /const profileOrder =/);
});

test("webhook-created mappings cannot backdate a reassigned biometric ID", () => {
  const start = route.indexOf("async function createEnrolmentFromWorker");
  const end = route.indexOf("async function reconcileLegacyEnrolment", start);
  assert.ok(start >= 0 && end > start, "expected the webhook enrolment creator");
  const create = route.slice(start, end);

  assert.match(create, /\.rpc\("replace_biometric_enrolment_assignment"/);
  assert.match(create, /p_account_id: worker\.accountId/);
  assert.match(create, /p_profile_type: worker\.profileType/);
  assert.doesNotMatch(create, /p_close_ids|p_existing_id|p_payload|p_prior_effective_to/);
  assert.doesNotMatch(create, /\.from\("biometric_enrolments"\)[\s\S]*?\.insert\(payload\)/);
  assert.doesNotMatch(create, /effective_from: worker\.dateOfJoin \|\| today/);
});

test("delayed punches resolve historical ownership and never auto-link from today's master", () => {
  const lookupStart = route.indexOf("async function findEffectiveEnrolments");
  const lookupEnd = route.indexOf("async function findWorkerMatches", lookupStart);
  const lookup = route.slice(lookupStart, lookupEnd);
  assert.match(lookup, /\.lte\("effective_from", effectiveDate\)/);
  assert.match(lookup, /effective_to\.is\.null,effective_to\.gte\.\$\{effectiveDate\}/);

  const postStart = route.indexOf("export async function POST");
  const post = route.slice(postStart);
  assert.match(post, /const punchCalendarDate = istDate\(punchTime\)/);
  assert.match(post, /findEffectiveEnrolments\([\s\S]*?punchCalendarDate[\s\S]*?\)/);
  assert.match(post, /canAutoLinkCurrentAssignment = punchCalendarDate === istDate\(new Date\(\)\)/);
  assert.match(post, /if \(canAutoLinkCurrentAssignment && workers\.length/);
  assert.match(route, /if \(enrolment\.effective_to !== null\) return enrolment/);
});

test("Biometric Monitor checks canonical and legacy Helper tables", () => {
  assert.match(monitor, /\["Helper", "helpers"\]/);
  assert.match(monitor, /\["Legacy Helper", "workforce_helpers"\]/);
});
