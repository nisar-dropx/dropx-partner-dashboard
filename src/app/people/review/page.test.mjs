import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("profile review loads all under-review profile rows with explicit range paging", () => {
  assert.match(page, /readAllRows\(admin/);
  assert.match(page, /\.order\("updated_at", \{ ascending: false \}\)/);
  assert.match(page, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(page, /const profileResults = await Promise\.all\(profileQueries\)/);
});

test("profile review reasons are scoped to current account IDs in bounded batches", () => {
  assert.match(page, /profileReviewIdBatches\(profileIds\)/);
  assert.match(page, /\.eq\("profile_type", profileType\)/);
  assert.match(page, /\.in\("account_id", accountIds\)/);
  assert.match(page, /for \(const \[profileType, profileIds\] of profileIdsByType\)/);
  assert.match(page, /for \(const row of verificationRows\)/);
});

test("profile review renders a dynamic 50-profile page without dropping filtered results", () => {
  assert.match(page, /paginateProfileReview\(filteredProfiles, searchParams\?\.page\)/);
  assert.match(page, /paginatedProfiles\.items\.map/);
  assert.match(page, /Page \{paginatedProfiles\.page\} of \{paginatedProfiles\.pageCount\}/);
  assert.match(page, /listHref\(paginatedProfiles\.page \+ 1\)/);
});
