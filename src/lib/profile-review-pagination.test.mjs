import assert from "node:assert/strict";
import test from "node:test";
import {
  paginateProfileReview,
  profileReviewIdBatches,
  PROFILE_REVIEW_PAGE_SIZE
} from "./profile-review-pagination.ts";

test("profile review pagination keeps every profile across dynamic 50-row pages", () => {
  const profiles = Array.from({ length: 125 }, (_, index) => ({ id: `profile-${index + 1}` }));

  const first = paginateProfileReview(profiles, 1);
  const second = paginateProfileReview(profiles, "2");
  const third = paginateProfileReview(profiles, 3);

  assert.equal(PROFILE_REVIEW_PAGE_SIZE, 50);
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [50, 50, 25]);
  assert.deepEqual([first.firstItem, first.lastItem], [1, 50]);
  assert.deepEqual([third.firstItem, third.lastItem], [101, 125]);
  assert.equal(third.pageCount, 3);
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map((profile) => profile.id),
    profiles.map((profile) => profile.id)
  );
});

test("profile review pagination clamps invalid and stale page numbers", () => {
  const profiles = Array.from({ length: 51 }, (_, index) => index);

  assert.equal(paginateProfileReview(profiles, "not-a-page").page, 1);
  assert.equal(paginateProfileReview(profiles, -4).page, 1);
  assert.equal(paginateProfileReview(profiles, 99).page, 2);
  assert.deepEqual(paginateProfileReview([], 8), {
    items: [],
    page: 1,
    pageCount: 1,
    pageSize: 50,
    total: 0,
    firstItem: 0,
    lastItem: 0
  });
});

test("review reason account IDs are deduplicated and split into bounded batches", () => {
  const ids = [
    ...Array.from({ length: 125 }, (_, index) => `profile-${index + 1}`),
    "profile-1",
    "",
    null
  ];
  const batches = profileReviewIdBatches(ids);

  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 25]);
  assert.equal(new Set(batches.flat()).size, 125);
});
