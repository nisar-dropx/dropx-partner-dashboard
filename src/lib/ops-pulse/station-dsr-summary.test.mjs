import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_TID, mapBoardTidExportRows } from "./station-board-tids.ts";
import { physicalAtStationRows, stationDsrMetricRows, stationDsrReportRows, summarizeStationDsrRows, STATION_DSR_PENDING_HEADER, STATION_DSR_OVERDUE_HEADER } from "./station-dsr-summary.ts";
import { dsrStationTable } from "./board-detail-report.ts";
import { normalizeBoard } from "./station-board.ts";

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
  assert.deepEqual(summary, { eddPending: 1, overduePending: 1, physicalAtStation: 2, dispatchUnconfirmed: 0 });
  assert.deepEqual(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "assigned").map((item) => item.trackingId), ["DEL"]);
});

test("future stock never inflates pending today; selected business date controls historical reports", () => {
  const rows = [
    ...Array.from({ length: 808 }, (_, i) => row(`FUTURE-${i}`, BOARD_TID.EDD, "INDUCTED", "2026-11-05")),
    row("TODAY", BOARD_TID.EDD, "INDUCTED"),
    row("OVERDUE", BOARD_TID.AGEING, "at station", "2026-11-03"),
    row("NO-DATE", BOARD_TID.EDD, "INDUCTED", ""),
    row("INVALID", BOARD_TID.EDD, "INDUCTED", "2026-02-30"),
  ];
  assert.deepEqual(summarizeStationDsrRows(rows, "2026-11-04").QLDA, { eddPending: 1, overduePending: 1, physicalAtStation: 2, dispatchUnconfirmed: 0 });
  assert.equal(stationDsrMetricRows(rows, "QLDA", "2026-11-05", "eddPending").length, 808);
  assert.equal(stationDsrMetricRows(rows, "QLDA", "2026-11-05", "overduePending").length, 2);
  assert.deepEqual(physicalAtStationRows(rows, "invalid"), []);
});

test("today's dispatch and attempts override receipt rows; Other is explicitly unverified", () => {
  const outcomes = [BOARD_TID.DELIVERED, BOARD_TID.OOR, BOARD_TID.FAILED, BOARD_TID.REJECTED, "Failed", "Rejected", BOARD_TID.OTHER];
  const rows = outcomes.flatMap(bucket => [row(bucket, BOARD_TID.EDD, "AT_STATION"), row(bucket, bucket, "AT_STATION")]);
  // Driver identity by itself is not dispatch evidence.
  rows.push({ ...row("NOT-DISPATCHED", BOARD_TID.EDD, "INDUCTED"), driverId: "DA-1" });
  assert.deepEqual(physicalAtStationRows(rows, "2026-11-04").map(r => r.trackingId), ["NOT-DISPATCHED"]);
  assert.deepEqual(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "dispatchUnconfirmed").map(r => r.trackingId), [BOARD_TID.OTHER]);
  assert.equal(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "assigned").length, outcomes.length);
  rows.push(row(BOARD_TID.OTHER, BOARD_TID.OOR, "ON_ROAD"));
  assert.equal(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "dispatchUnconfirmed").length, 0);
});

test("return and nonphysical states cannot become actionable EDD pending", () => {
  const states = ["READY_FOR_FC_RETURN", "IN_TRANSIT_DS_TO_FC", "HOLD_FOR_CUSTOMER_REQUEST", "HOLD_FOR_REDELIVERY", "DELIVERED", "ON_ROAD_WITH_DELIVERY_ASSOCIATE", "UNKNOWN"];
  const rows = states.map(state => row(state, BOARD_TID.EDD, state));
  assert.deepEqual(physicalAtStationRows(rows, "2026-11-04"), []);
});

test("deduplication and outcome exclusion stay within station; current inventory overrides stale ageing", () => {
  const rows = [
    row(" SHARED ", BOARD_TID.EDD, "INDUCTED"),
    row("SHARED", BOARD_TID.AGEING, "INDUCTED"),
    row("SHARED", BOARD_TID.OOR, "ON_ROAD", "2026-11-04", "STATION-B"),
    row("RESCHEDULED", BOARD_TID.EDD, "INDUCTED", "2026-11-05"),
    row("RESCHEDULED", BOARD_TID.AGEING, "INDUCTED", "2026-11-03"),
    row(" ", BOARD_TID.EDD, "INDUCTED"),
    row("RECEIPT-ALIAS", BOARD_TID.EDD, "INDUCT", "2026-11-03"),
    row("RECEIPT-ALIAS", BOARD_TID.AGEING, "Inducted", "2026-11-03"),
  ];
  assert.deepEqual(physicalAtStationRows(rows, "2026-11-04").map(r => r.trackingId).sort(), ["RECEIPT-ALIAS", "SHARED"]);
  assert.deepEqual(physicalAtStationRows([...rows].reverse(), "2026-11-04").map(r => r.trackingId).sort(), ["RECEIPT-ALIAS", "SHARED"]);
  assert.deepEqual(summarizeStationDsrRows([], "2026-11-04", ["EMPTY"]).EMPTY, { eddPending: 0, overduePending: 0, physicalAtStation: 0, dispatchUnconfirmed: 0 });
  assert.equal(summarizeStationDsrRows([], "2026-11-04").MISSING, undefined);
});

test("worker mapping, table, clickable TIDs and Excel use the same non-overlapping cohorts", () => {
  const fixture = [row("DUE", BOARD_TID.EDD, "INDUCTED"), row("OLD", BOARD_TID.AGEING, "INDUCTED", "2026-11-03"), row("FUTURE", BOARD_TID.EDD, "INDUCTED", "2026-11-05"), row("DONE", BOARD_TID.DELIVERED, "DELIVERED"), row("CHECK", BOARD_TID.EDD, "AT_STATION"), row("CHECK", BOARD_TID.OTHER, "AT_STATION")];
  const rows = mapBoardTidExportRows(fixture.map(r => ({ ...r, bucket: r.sourceBucket, state: r.currentState })), "dsr-station");
  const summary = summarizeStationDsrRows(rows, "2026-11-04");
  const stations = [{ stationCode: "QLDA", board: normalizeBoard({ daDsr: [{ driverId: "DA", total: 2, delivered: 1, other: 1 }] }) }];
  const table = dsrStationTable(stations, {}, false, summary);
  assert.deepEqual(table.headers.slice(2, 4), [STATION_DSR_PENDING_HEADER, STATION_DSR_OVERDUE_HEADER]);
  assert.equal(table.rows[0][2].text, String(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "eddPending").length));
  assert.equal(table.rows[0][3].text, String(stationDsrMetricRows(rows, "QLDA", "2026-11-04", "overduePending").length));
  const exported = stationDsrReportRows(rows, "2026-11-04");
  assert.deepEqual(exported.map(r => r.trackingId), ["DUE", "OLD", "DONE", "CHECK"]);
  assert.deepEqual(exported.map(r => r.status), [STATION_DSR_PENDING_HEADER, STATION_DSR_OVERDUE_HEADER, "Delivered", "Other / pending"]);
  assert.equal(exported.length, new Set(exported.map(r => `${r.stationCode}:${r.trackingId}`)).size);
  assert.equal(exported.length, Number(table.rows[0][2].text) + Number(table.rows[0][3].text) + Number(table.rows[0][4].text));
});
