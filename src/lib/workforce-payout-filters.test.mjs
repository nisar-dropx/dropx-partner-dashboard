import assert from "node:assert/strict";
import test from "node:test";
import { matchesWorkforcePayoutFilters, workforcePayoutFacetValues } from "./workforce-payout-filters.ts";

const row = {
  dropxId: "KOZA5249",
  dropxStatus: "Active",
  name: "Midhun T",
  providerMemberId: "No provider ID",
  providerMemberName: "Direct allocation",
  designation: "DR - Driver",
  location: "KOZA",
  provider: "Direct",
  mappingStatus: "Not required",
  status: "Ready for review",
  paymentMethodBreakdown: [
    { label: "Fixed Pay Per Month" },
    { label: "Van Rent Per Day" }
  ]
};

const all = { designations: [], locations: [], providers: [], methods: [], mappingStatuses: [], statuses: [] };

test("empty selections keep every facet unfiltered", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "", all), true);
});

test("multiple values within one facet use OR matching", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    locations: ["KLZH", "KOZA"],
    methods: ["Per Packet", "Van Rent Per Day"]
  }), true);
});

test("different facets combine with AND matching", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    locations: ["KOZA"],
    providers: ["Amazon"]
  }), false);
});

test("designation is a searchable multi-select facet", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    designations: ["DR - Driver", "DA - Delivery Associate"]
  }), true);
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    designations: ["DA - Delivery Associate"]
  }), false);
  assert.equal(matchesWorkforcePayoutFilters(row, "driver", all), true);
});

test("mapping status is a searchable multi-select facet", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    mappingStatuses: ["Mapped", "Not required"]
  }), true);
  assert.equal(matchesWorkforcePayoutFilters(row, "", {
    ...all,
    mappingStatuses: ["ID not mapped"]
  }), false);
  assert.equal(matchesWorkforcePayoutFilters(row, "not required", all), true);
});

test("search and multi-select facets are both applied", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "midhun", {
    ...all,
    statuses: ["Ready for review"]
  }), true);
  assert.equal(matchesWorkforcePayoutFilters(row, "another person", all), false);
});

test("dated allocations remain filterable by every location and provider segment", () => {
  const transferred = { ...row, location: "KOZA / KTUO", provider: "Amazon / Flipkart" };
  assert.deepEqual(workforcePayoutFacetValues(transferred.location), ["KOZA", "KTUO"]);
  assert.equal(matchesWorkforcePayoutFilters(transferred, "", { ...all, locations: ["KTUO"] }), true);
  assert.equal(matchesWorkforcePayoutFilters(transferred, "", { ...all, providers: ["Flipkart"] }), true);
  assert.equal(matchesWorkforcePayoutFilters(transferred, "", { ...all, locations: ["KLZH"] }), false);
});
