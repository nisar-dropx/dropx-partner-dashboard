import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("ordinary registration queue retains the origin/main status-only queries", () => {
  const ordinaryQueue = page.slice(
    page.indexOf("const employeeSelect"),
    page.indexOf("// Self-edit reviews are additive")
  );

  assert.match(ordinaryQueue, /\.eq\("profile_completion_status", "under_review"\)/);
  assert.equal((ordinaryQueue.match(/\.eq\("onboarding_status", "under_review"\)/g) ?? []).length, 2);
  assert.doesNotMatch(ordinaryQueue, /profile_edit_review_pending/);
  assert.doesNotMatch(ordinaryQueue, /connect_profile_edit_audit/);
  assert.match(ordinaryQueue, /const profileResults = await Promise\.all\(profileQueries\)/);
  assert.match(ordinaryQueue, /profileEditReviewPending: false/);
});

test("self-edit review rows are loaded additively and never include helpers", () => {
  assert.match(page, /async function readOptionalRows\(query: unknown\)/);
  assert.match(page, /catch \{\s+return \[\] as Array<Record<string, unknown>>/);
  assert.match(page, /const profileEditTypes: WorkforceProfileType\[\] = \["employee", "workforce", "contractor", "vendor"\]/);
  assert.match(page, /\.eq\("profile_edit_review_pending", true\)/);
  assert.match(page, /\.eq\("profile_completion_status", "active"\)/);
  assert.match(page, /\.eq\("onboarding_status", "active"\)/);
  assert.match(page, /\.eq\("is_active", true\)/);
  assert.doesNotMatch(
    page.slice(page.indexOf("const profileEditTypes"), page.indexOf("const profileIdsByType")),
    /"worker"|helpers/
  );
});

test("profile-edit audit enrichment is optional and cannot fail the ordinary queue", () => {
  const auditSection = page.slice(
    page.indexOf("const latestProfileEditFields"),
    page.indexOf("const issuesByProfile")
  );
  assert.match(auditSection, /readOptionalRows\(admin/);
  assert.match(auditSection, /from\("connect_profile_edit_audit"\)/);
  assert.doesNotMatch(auditSection, /return \{ profiles: \[\] as ReviewProfile\[\], error:/);
  assert.match(page, /kind: "profile_edit"/);
  assert.match(page, /"Profile details changed"/);
});

test("review reasons remain scoped to current account IDs in bounded batches", () => {
  assert.match(page, /profileReviewIdBatches\(profileIds\)/);
  assert.match(page, /\.eq\("profile_type", profileType\)/);
  assert.match(page, /\.in\("account_id", accountIds\)/);
  assert.match(page, /for \(const \[profileType, profileIds\] of profileIdsByType\)/);
  assert.match(page, /for \(const row of verificationRows\)/);
});

test("only self-edit forms use the isolated action and optimistic version", () => {
  assert.match(page, /import \{ reviewPeopleProfile, reviewProfileEdit \} from "\.\/actions"/);
  assert.match(page, /const selectedReviewAction = selected\?\.profileEditReviewPending \? reviewProfileEdit : reviewPeopleProfile/);
  assert.equal((page.match(/action=\{selectedReviewAction\}/g) ?? []).length, 2);
  assert.equal((page.match(/selected\.profileEditReviewPending\s+\? <input name="review_version"/g) ?? []).length, 2);
});

test("profile review renders a dynamic 50-profile page without dropping filtered results", () => {
  assert.match(page, /paginateProfileReview\(filteredProfiles, searchParams\?\.page\)/);
  assert.match(page, /paginatedProfiles\.items\.map/);
  assert.match(page, /Page \{paginatedProfiles\.page\} of \{paginatedProfiles\.pageCount\}/);
  assert.match(page, /listHref\(paginatedProfiles\.page \+ 1\)/);
});
