import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("profile review loads all under-review profile rows with explicit range paging", () => {
  assert.match(page, /readAllRows\(admin/);
  assert.match(page, /\.order\("updated_at", \{ ascending: false \}\)/);
  assert.match(page, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(page, /const profileResults = await Promise\.all\(profileQueries\)/);
  assert.equal(
    (page.match(/\.or\("(?:profile_completion_status|onboarding_status)\.eq\.under_review,profile_edit_review_pending\.eq\.true"\)/g) ?? []).length,
    3
  );
});

test("profile review reasons are scoped to current account IDs in bounded batches", () => {
  assert.match(page, /profileReviewIdBatches\(profileIds\)/);
  assert.match(page, /\.eq\("profile_type", profileType\)/);
  assert.match(page, /\.in\("account_id", accountIds\)/);
  assert.match(page, /for \(const \[profileType, profileIds\] of profileIdsByType\)/);
  assert.match(page, /for \(const row of verificationRows\)/);
  assert.match(page, /from\("connect_profile_edit_audit"\)/);
  assert.match(page, /profile\.profileEditReviewPending/);
  assert.match(page, /kind: "profile_edit"/);
});

test("profile review decisions are bound to the version rendered in the modal", () => {
  assert.equal((page.match(/name="review_version"/g) ?? []).length, 2);
  assert.match(page, /value=\{selected\.updatedAt \?\? ""\}/);
});

test("profile review renders a dynamic 50-profile page without dropping filtered results", () => {
  assert.match(page, /paginateProfileReview\(filteredProfiles, searchParams\?\.page\)/);
  assert.match(page, /paginatedProfiles\.items\.map/);
  assert.match(page, /Page \{paginatedProfiles\.page\} of \{paginatedProfiles\.pageCount\}/);
  assert.match(page, /listHref\(paginatedProfiles\.page \+ 1\)/);
});
