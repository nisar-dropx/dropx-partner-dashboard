import assert from "node:assert/strict";
import {
  dateRangesOverlap,
  dayBefore,
  eachIsoDate,
  isValidAmazonTransporterId,
  normalizeAmazonTransporterId,
} from "./amazon-transporter-assignments.ts";

assert.equal(normalizeAmazonTransporterId(" a31fshglu5olia "), "A31FSHGLU5OLIA");
assert.equal(isValidAmazonTransporterId("A31FSHGLU5OLIA"), true);
assert.equal(isValidAmazonTransporterId("2000017249530"), false);
assert.equal(isValidAmazonTransporterId("A12"), false);

assert.equal(dateRangesOverlap("2026-10-01", "2026-10-10", "2026-10-11", "2026-10-20"), false);
assert.equal(dateRangesOverlap("2026-10-01", "2026-10-10", "2026-10-10", "2026-10-20"), true);
assert.equal(dateRangesOverlap("2026-10-01", null, "2026-10-15", "2026-10-20"), true);

assert.equal(dayBefore("2026-10-11"), "2026-10-10");
assert.deepEqual(eachIsoDate("2026-10-01", "2026-10-03"), [
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
]);

console.log("amazon-transporter-assignments.test.mjs: ok");
