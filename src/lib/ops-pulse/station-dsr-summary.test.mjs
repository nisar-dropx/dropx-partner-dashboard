import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_TID } from "./station-board-tids.ts";
import { physicalAtStationRows, stationDsrMetricRows, summarizeStationDsrRows } from "./station-dsr-summary.ts";

const row = (trackingId, sourceBucket, currentState, edd = "2026-11-04", stationCode = "QLDA") => ({
  stationCode, trackingId, sourceBucket, currentState, status: currentState, edd, driverId: "", driverName: "",
});

test("physical-at-station keeps dispatch-eligible stock and excludes same-day outcomes and ineligible states", () => {
  const rows = [
    row("FRESH", BOARD_TID.AGEING, "INDUCTED"),
    row("PRIOR_RETURN", BOARD_TID.AGEING, "RECEIVED", "2026-11-03"),
    row("FAILED_TODAY", BOARD_TID.AGEING, "RECEIVED", "2026-11-03"),
    row("FAILED_TODAY", BOARD_TID.FAILED, "DELIVERY_FAILED", "2026-11-04"),
    row("FC", BOARD_TID.AGEING, "READY_FOR_FC_RETURN", "2026-11-03"),
    row("TRANSIT", BOARD_TID.AGEING, "IN_TRANSIT_DS_TO_FC", "2026-11-03"),
    row("HCR", BOARD_TID.AGEING, "HOLD_FOR_CUSTOMER_REQUEST", "2026-11-03"),
    row("FUTURE", BOARD_TID.AGEING, "AT_STATION", "2026-11-05"),
  ];
  assert.deepEqual(physicalAtStationRows(rows, "2026-11-04").map((item) => item.trackingId), ["FRESH", "PRIOR_RETURN"]);
});

test("station DSR summary deduplicates one actionable EDD-pending-at-station count", () => {
  const rows = [
    row("TODAY", BOARD_TID.EDD, "INDUCTED"),
    row("TODAY", BOARD_TID.EDD, "INDUCTED"),
    row("OLD", BOARD_TID.EDD, "INDUCTED", "2026-11-03"),
    row("OLD", BOARD_TID.AGEING, "INDUCTED", "2026-11-03"),
    row("DEL", BOARD_TID.DELIVERED, "DELIVERED"),
  ];
  const summary = summarizeStationDsrRows(rows, "2026-11-04").QLDA;
  assert.deepEqual(summary, { eddPending: 2, physicalAtStation: 1 });
  assert.deepEqual(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "assigned").map((item) => item.trackingId), ["DEL"]);
});
