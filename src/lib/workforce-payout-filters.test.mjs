import assert from "node:assert/strict";
import test from "node:test";
import { matchesWorkforcePayoutFilters } from "./workforce-payout-filters.ts";

const row = {
  dropxId: "KOZA5249",
  name: "Midhun T",
  providerMemberId: "No provider ID",
  providerMemberName: "Direct allocation",
  location: "KOZA",
  provider: "Direct",
  status: "Ready for review",
  paymentMethodBreakdown: [
    { label: "Fixed Pay Per Month" },
    { label: "Van Rent Per Day" }
  ]
};

const all = { locations: [], providers: [], methods: [], statuses: [] };

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

test("search and multi-select facets are both applied", () => {
  assert.equal(matchesWorkforcePayoutFilters(row, "midhun", {
    ...all,
    statuses: ["Ready for review"]
  }), true);
  assert.equal(matchesWorkforcePayoutFilters(row, "another person", all), false);
});
