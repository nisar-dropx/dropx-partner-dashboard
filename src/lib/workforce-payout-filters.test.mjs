import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFORCE_PAYOUT_FILTER_NONE,
  matchesWorkforcePayoutFilters,
  reconcileWorkforcePayoutFilterSelection,
  toggleWorkforcePayoutFilterOption,
  workforcePayoutFacetValues,
  workforcePayoutPaymentStatus,
  workforcePayoutHoldStatus,
  workforcePayoutReadiness
} from "./workforce-payout-filters.ts";
import { facetRows } from "./dependent-filters.ts";

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

const payment = (overrides = {}) => ({ ...row, paymentSummary: {
  status: null, paidAmount: 0, processingAmount: 0, balancePayable: 1000,
  eligible: true, eligibilityCode: "eligible", ...overrides
} });

test("payment states distinguish published from paid and unavailable from unpaid", () => {
  assert.equal(workforcePayoutPaymentStatus({ ...payment(), status: "Payment Published" }), "Unpaid");
  assert.equal(workforcePayoutPaymentStatus(payment({ status: "Paid", paidAmount: 1000, balancePayable: 0 })), "Paid");
  assert.equal(workforcePayoutPaymentStatus({ ...payment({ status: "Paid" }), status: "Partially Paid" }), "Partially paid");
  assert.equal(workforcePayoutPaymentStatus(payment({ paidAmount: 100, balancePayable: 900 })), "Partially paid");
  assert.equal(workforcePayoutPaymentStatus(payment({ processingAmount: 1000 })), "Processing");
  assert.equal(workforcePayoutPaymentStatus(payment({ status: "Payment Failed" })), "Failed");
  assert.equal(workforcePayoutPaymentStatus(payment({ status: "Payment Cancelled" })), "Cancelled");
  assert.equal(workforcePayoutPaymentStatus(row), "Not available");
  assert.equal(workforcePayoutPaymentStatus(payment({ eligible: null })), "Not available");
  assert.equal(workforcePayoutPaymentStatus(payment({ eligible: false, eligibilityCode: "no_positive_balance" })), "No balance due");
});

test("hold and dispute blocking reasons stay independent from amounts already paid", () => {
  const held = payment({ status: "Partially Paid", paidAmount: 100, eligible: false, eligibilityCode: "payment_on_hold" });
  assert.equal(workforcePayoutHoldStatus(held), "On hold");
  assert.equal(workforcePayoutPaymentStatus(held), "Partially paid");
  assert.equal(workforcePayoutReadiness(held), "On hold");
  const disputed = payment({ eligible: false, eligibilityCode: "payout_dispute_open" });
  assert.equal(workforcePayoutReadiness(disputed), "Dispute pending");
  assert.equal(workforcePayoutReadiness(payment()), "Ready to pay");
  assert.equal(workforcePayoutReadiness(payment({ eligible: false, eligibilityCode: "beneficiary_ifsc_invalid" })), "Invalid bank details");
  assert.equal(workforcePayoutReadiness(payment({ eligible: false, eligibilityCode: "publication_missing" })), "Not published");
  assert.equal(workforcePayoutReadiness(payment({ eligible: false, eligibilityCode: "new_unknown_blocker" })), "Needs review");
});

test("bank and dispute filters combine with location, model and search", () => {
  const disputed = { ...payment({ eligible: false, eligibilityCode: "payout_dispute_open" }), model: "EDSP", bankFileStatus: "Blocked" };
  const filters = { ...all, locations: ["KOZA"], models: ["EDSP"], bankFiles: ["Blocked"], readiness: ["Dispute pending", "On hold"] };
  assert.equal(matchesWorkforcePayoutFilters(disputed, "Midhun", filters), true);
  assert.equal(matchesWorkforcePayoutFilters(disputed, "", { ...filters, bankFiles: ["Available"] }), false);
  assert.equal(matchesWorkforcePayoutFilters(disputed, "", { ...filters, locations: ["KLZA"] }), false);
});

test("dependent readiness choices use all scoped rows and retain zero-result selections", () => {
  const rows = [...Array.from({ length: 60 }, () => payment()), { ...payment({ eligible: false, eligibilityCode: "payout_dispute_open" }), location: "KLZA" }];
  const facets = facetRows(rows, {
    location: { selected: ["KLZA"], values: r => r.location },
    readiness: { selected: [], values: workforcePayoutReadiness }
  });
  assert.deepEqual(facets.values("readiness"), ["Dispute pending"]);
  assert.equal(facets.rows.length, 1);
  const empty = facetRows(rows, {
    location: { selected: ["KOZA"], values: r => r.location },
    readiness: { selected: ["Dispute pending"], values: workforcePayoutReadiness }
  });
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.values("readiness").includes("Dispute pending"));
});

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

test("unchecking an option from All keeps every other option selected", () => {
  const options = ["A", "B", "C"];
  assert.deepEqual(toggleWorkforcePayoutFilterOption(options, [], "B"), ["A", "C"]);
  assert.deepEqual(toggleWorkforcePayoutFilterOption(options, ["A", "C"], "A"), ["C"]);
});

test("restoring the last excluded option normalizes the selection back to All", () => {
  assert.deepEqual(toggleWorkforcePayoutFilterOption(["A", "B", "C"], ["A", "C"], "B"), []);
});

test("unchecking the only or final selected option represents none instead of resetting to All", () => {
  assert.deepEqual(toggleWorkforcePayoutFilterOption(["A"], [], "A"), [WORKFORCE_PAYOUT_FILTER_NONE]);
  assert.deepEqual(toggleWorkforcePayoutFilterOption(["A", "B"], ["A"], "A"), [WORKFORCE_PAYOUT_FILTER_NONE]);
  assert.equal(matchesWorkforcePayoutFilters(row, "", { ...all, locations: [WORKFORCE_PAYOUT_FILTER_NONE] }), false);
  assert.deepEqual(toggleWorkforcePayoutFilterOption(["A"], [WORKFORCE_PAYOUT_FILTER_NONE], "A"), []);
});

test("an All-minus-one selection excludes only the unchecked facet", () => {
  const selected = toggleWorkforcePayoutFilterOption(["KOZA", "KTUO", "KLZH"], [], "KTUO");
  assert.equal(matchesWorkforcePayoutFilters(row, "", { ...all, locations: selected }), true);
  assert.equal(matchesWorkforcePayoutFilters({ ...row, location: "KTUO" }, "", { ...all, locations: selected }), false);
  assert.equal(matchesWorkforcePayoutFilters({ ...row, location: "KLZH" }, "", { ...all, locations: selected }), true);
});

test("refreshing payout rows removes stale facet values without breaking filters", () => {
  assert.deepEqual(reconcileWorkforcePayoutFilterSelection(["A", "C"], ["A", "B"]), ["A"]);
  assert.deepEqual(reconcileWorkforcePayoutFilterSelection(["C"], ["A", "B"]), []);
  assert.deepEqual(reconcileWorkforcePayoutFilterSelection(["A"], [WORKFORCE_PAYOUT_FILTER_NONE]), [WORKFORCE_PAYOUT_FILTER_NONE]);
  assert.deepEqual(reconcileWorkforcePayoutFilterSelection(["A", "B"], ["A", "B"]), []);
});
