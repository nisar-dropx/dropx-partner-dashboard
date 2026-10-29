import assert from "node:assert/strict";
import test from "node:test";
import { regionForStation, STATION_BOARD_REGIONS } from "./station-board-regions.ts";
import {
  collectEddDates,
  cReturnStatuses,
  eddPivot,
  normalizeBoard,
  stationBoardSheets,
} from "./station-board.ts";

test("region map covers KL, AP and OD&CG station lists", () => {
  assert.equal(regionForStation("KTUR"), "KL");
  assert.equal(regionForStation("XAPI"), "AP");
  assert.equal(regionForStation("JUGD"), "ODCG");
  assert.equal(regionForStation("ZZZZ"), "OTHER");
  assert.equal(STATION_BOARD_REGIONS.find((r) => r.id === "KL").stations.length, 14);
  assert.equal(STATION_BOARD_REGIONS.find((r) => r.id === "AP").stations.length, 11);
  assert.equal(STATION_BOARD_REGIONS.find((r) => r.id === "ODCG").stations.length, 9);
});

test("EDD pivot and C-Return / DSR sheet builders stay stable", () => {
  const board = normalizeBoard({
    eddByDate: { "2026-10-29": 12, "2026-10-30": 3 },
    cReturn: { AT_STATION: 2, PICKUP_DONE: 8, DELAYED: 1 },
    cReturnTotal: 11,
    pickupDone: 8,
    pickupDonePct: 73,
    daDsr: [
      { driverId: "A1", driverName: "Ada", delivered: 0, failed: 0, rejected: 0, oor: 5, total: 5, dsrPct: 0 },
      { driverId: "A2", driverName: "Ben", delivered: 4, failed: 1, rejected: 0, oor: 0, total: 5, dsrPct: 80 },
    ],
    zeroDeliveries: 1,
  });
  assert.equal(board.pickupDonePct, 73);
  assert.equal(cReturnStatuses(board).find((r) => r.status === "PICKUP_DONE").count, 8);

  const stations = [
    { stationCode: "KTUR", hasSnapshot: true, fetchedAt: null, businessDate: "2026-10-29", board },
    {
      stationCode: "XAPI",
      hasSnapshot: true,
      fetchedAt: null,
      businessDate: "2026-10-29",
      board: normalizeBoard({
        eddByDate: { "2026-10-29": 4 },
        cReturn: { PICKUP_DONE: 1 },
        cReturnTotal: 1,
        pickupDone: 1,
        pickupDonePct: 100,
        daDsr: [],
        zeroDeliveries: 0,
      }),
    },
  ];
  const dates = collectEddDates(stations, "2026-10-29");
  assert.ok(dates.includes("2026-10-29"));
  const pivot = eddPivot(stations, ["2026-10-29", "2026-10-30"]);
  assert.equal(pivot.grandTotal, 19);
  assert.equal(pivot.columnTotals["2026-10-29"], 16);

  const sheets = stationBoardSheets(
    { asOf: "", businessDate: "2026-10-29", dates: [], stations, run: null },
    "full",
    stations,
  );
  assert.ok(sheets.some((sheet) => sheet.name === "EDD by date"));
  assert.ok(sheets.some((sheet) => sheet.name === "C-Return"));
  assert.ok(sheets.some((sheet) => sheet.name === "Zero deliveries"));
  const zero = sheets.find((sheet) => sheet.name === "Zero deliveries");
  assert.equal(zero.rows.length, 1);
  assert.equal(zero.rows[0]["DA's Name"], "Ada");
});
