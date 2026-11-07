import test from "node:test";
import assert from "node:assert/strict";
import { compareBulkAttendancePeriod } from "./worked-id-bulk-period.ts";

const dates = Array.from(
  { length: 31 },
  (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`,
);
const base = {
  from: dates[0],
  to: dates[30],
  quantity: 10,
  basis: "days",
  today: "2026-11-07",
  biometricDates: dates.slice(0, 8),
  reportDates: dates,
  deliveries: [],
};
const delivery = (date, providerId = "ID1", count = 20) => ({
  date,
  providerId,
  count,
});
test("ten bulk days and six delivery dates flag four, irrespective of biometric days", () => {
  const result = compareBulkAttendancePeriod({
    ...base,
    deliveries: dates.slice(0, 6).map((d) => delivery(d)),
  });
  assert.equal(result.gap, 4);
  assert.equal(result.biometricDates.length, 8);
  assert.equal(result.needsReview, true);
  assert.equal(result.status, "4 days to review");
});
test("multiple mapped IDs and duplicate source rows never multiply delivery days", () => {
  const result = compareBulkAttendancePeriod({
    ...base,
    deliveries: [
      ...dates
        .slice(0, 6)
        .flatMap((d) => [delivery(d), delivery(d, "ID2"), delivery(d)]),
      delivery(dates[6], "ID3", 0),
      delivery("2026-09-30"),
    ],
  });
  assert.equal(result.deliveryDates.length, 6);
  assert.equal(result.gap, 4);
});
test("more delivery dates than uploaded attendance has no negative gap or automatic review approval", () => {
  const result = compareBulkAttendancePeriod({
    ...base,
    deliveries: dates.slice(0, 12).map((d) => delivery(d)),
  });
  assert.equal(result.gap, 0);
  assert.equal(result.needsReview, false);
  assert.equal(result.status, "No day-count shortfall");
});
test("missing reports, ambiguous ownership and an unfinished period never look reconciled", () => {
  const delivered = {
    ...base,
    deliveries: dates.slice(0, 10).map((d) => delivery(d)),
  };
  assert.equal(
    compareBulkAttendancePeriod({
      ...delivered,
      reportDates: dates.slice(0, 20),
    }).status,
    "Delivery report gaps",
  );
  assert.equal(
    compareBulkAttendancePeriod({ ...delivered, mappingConflict: true })
      .needsReview,
    true,
  );
  const ongoing = compareBulkAttendancePeriod({
    ...delivered,
    today: "2026-10-05",
  });
  assert.equal(ongoing.deliveryDates.length, 5);
  assert.equal(ongoing.ongoing, true);
  assert.equal(ongoing.status, "Period in progress");
});
test("fractional days stay fractional; hours are never silently converted to days", () => {
  assert.equal(
    compareBulkAttendancePeriod({
      ...base,
      quantity: 10.5,
      deliveries: dates.slice(0, 6).map((d) => delivery(d)),
    }).gap,
    4.5,
  );
  assert.equal(
    compareBulkAttendancePeriod({ ...base, basis: "hours", quantity: 80 }).gap,
    null,
  );
});
test("comparison uses full imported period and does not invent worked/absent dates", () => {
  const result = compareBulkAttendancePeriod({
    ...base,
    from: "2026-09-30",
    deliveries: [
      delivery("2026-09-30"),
      delivery("2026-10-01"),
      delivery("2026-11-01"),
    ],
    reportDates: ["2026-09-30", ...dates],
  });
  assert.deepEqual(result.deliveryDates, ["2026-09-30", "2026-10-01"]);
  assert.equal(result.gap, 8);
  assert.equal("absentDates" in result, false);
  assert.equal("workedDates" in result, false);
});
