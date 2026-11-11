import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  summarizeWorkforcePayoutStations,
  workforceStationReviewStatusLabel
} from "./workforce-payout-station-review.ts";

describe("workforce payout station review", () => {
  it("groups payable and blocked stations without inventing bank queries", () => {
    const stations = summarizeWorkforcePayoutStations([
      {
        location: "GNTF",
        locationId: "11111111-1111-1111-1111-111111111111",
        status: "Payment Published",
        netAmount: 1200,
        paymentDetailsAvailable: true,
        publicationPaymentReady: true,
        paymentSummary: {
          paidAmount: 200,
          processingAmount: 0,
          balancePayable: 1000,
          eligible: true,
          eligibilityCode: null,
          eligibilityMessage: null,
          status: "Partially Paid"
        }
      },
      {
        location: "GNTF",
        locationId: "11111111-1111-1111-1111-111111111111",
        status: "Configuration incomplete",
        netAmount: 500,
        paymentDetailsAvailable: false,
        publicationPaymentReady: false
      },
      {
        location: "KLZA",
        locationId: "22222222-2222-2222-2222-222222222222",
        status: "Ready for review",
        netAmount: 800,
        paymentDetailsAvailable: true,
        publicationPaymentReady: true,
        paymentSummary: {
          paidAmount: 0,
          processingAmount: 0,
          balancePayable: 800,
          eligible: true,
          eligibilityCode: null,
          eligibilityMessage: null,
          status: null
        }
      }
    ]);

    assert.equal(stations.length, 2);
    assert.equal(stations[0].station, "GNTF");
    assert.equal(stations[0].status, "blocked");
    assert.equal(stations[0].payableRows, 1);
    assert.equal(stations[0].blockedRows, 1);
    assert.equal(stations[0].balance, 1000);
    assert.equal(stations[0].paid, 200);
    assert.equal(workforceStationReviewStatusLabel(stations[0].status), "Needs attention");

    assert.equal(stations[1].station, "KLZA");
    assert.equal(stations[1].status, "review_pending");
    assert.equal(stations[1].reviewRows, 1);
  });

  it("marks publish-first when balance exists but publication is missing", () => {
    const [station] = summarizeWorkforcePayoutStations([
      {
        location: "KTUO",
        locationId: "33333333-3333-3333-3333-333333333333",
        status: "Awaiting production",
        netAmount: 1500,
        paymentDetailsAvailable: true,
        publicationPaymentReady: false,
        paymentSummary: {
          paidAmount: 0,
          processingAmount: 0,
          balancePayable: 0,
          eligible: false,
          eligibilityCode: "publication_missing",
          eligibilityMessage: "No current published payout is available for Workforce ID DF1 in this month.",
          status: null
        }
      }
    ]);
    assert.equal(station.status, "needs_publication");
    assert.equal(station.needsPublicationRows, 1);
    assert.match(String(station.blockerSample), /published payout/i);
  });

  it("keeps unassigned rows visible as their own station bucket", () => {
    const [station] = summarizeWorkforcePayoutStations([
      {
        location: "",
        locationId: null,
        status: "Payment Published",
        netAmount: 100,
        paymentDetailsAvailable: true,
        publicationPaymentReady: true,
        paymentSummary: {
          paidAmount: 0,
          processingAmount: 0,
          balancePayable: 100,
          eligible: true,
          eligibilityCode: null,
          eligibilityMessage: null,
          status: null
        }
      }
    ]);
    assert.equal(station.station, "Unassigned");
    assert.equal(station.status, "payable");
  });
});
