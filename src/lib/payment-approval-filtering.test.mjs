import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesPaymentApprovalFacets,
  paymentApprovalDateKey,
  selectedPaymentApprovalValues
} from "./payment-approval-filtering.ts";

const request = {
  location_code: "ERSE",
  payment_head_id: "head-1",
  created_at: "2026-09-01T20:00:00.000Z"
};

test("approval date facets use India time", () => {
  assert.equal(paymentApprovalDateKey(request.created_at), "2026-09-02");
});

test("repeated filter parameters are trimmed and deduplicated", () => {
  assert.deepEqual(selectedPaymentApprovalValues(["ERSE", "ERSE", " KOZA ", ""]), ["ERSE", "KOZA"]);
});

test("facet matching is OR within a facet and AND across facets", () => {
  assert.equal(matchesPaymentApprovalFacets(request, {
    stations: ["KOZA", "ERSE"],
    paymentHeads: ["head-1", "head-2"],
    dates: ["2026-09-01", "2026-09-02"]
  }), true);

  assert.equal(matchesPaymentApprovalFacets(request, {
    stations: ["ERSE"],
    paymentHeads: ["head-2"],
    dates: []
  }), false);
});

test("empty facet selections include every value", () => {
  assert.equal(matchesPaymentApprovalFacets(request, {
    stations: [],
    paymentHeads: [],
    dates: []
  }), true);
});
