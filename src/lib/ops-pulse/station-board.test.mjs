import assert from "node:assert/strict";
import test from "node:test";
import { regionForStation, STATION_BOARD_REGIONS } from "./station-board-regions.ts";
import {
  boardDayLabel,
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
  assert.equal(boardDayLabel("2026-10-29"), "Oct 29");
  assert.equal(boardDayLabel("2026-01-05"), "Jan 5");
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
  assert.deepEqual(dates, ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  const oldBoard = normalizeBoard({
    eddByDate: { "2026-09-15": 9, "2026-10-28": 2, "2026-11-02": 4 },
    cReturn: {},
    cReturnTotal: 0,
    pickupDone: 0,
    pickupDonePct: 0,
    daDsr: [],
    zeroDeliveries: 0,
  });
  assert.deepEqual(
    collectEddDates([{ stationCode: "QLDA", hasSnapshot: true, fetchedAt: null, businessDate: "2026-10-30", board: oldBoard }], "2026-10-30"),
    ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"],
  );
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
  assert.equal(zero.rows.length, 2);
  assert.equal(zero.rows[0]["DA's Name"], "Ada");
  assert.equal(zero.rows[1].Station, "Grand Total");
  assert.equal(zero.rows[1]["Grand Total"], zero.rows[0]["Grand Total"]);
});
