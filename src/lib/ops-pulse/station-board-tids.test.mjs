import assert from "node:assert/strict";
import test from "node:test";
import {
  boardTidSheetRows,
  mapBoardTidExportRows,
} from "./station-board-tids.ts";

test("mapBoardTidExportRows prefers BoardEDD and maps Ageing / zero DSR filters", () => {
  const flash = [
    { stationCode: "JUGD", trackingId: "T1", bucket: "BoardEDD", state: "INDUCTED", edd: "2026-11-03", driverId: "A1", driverName: "Ada" },
    { stationCode: "JUGD", trackingId: "T2", bucket: "EDD", state: "INDUCTED", edd: "2026-11-04", driverId: "", driverName: "" },
    { stationCode: "JUGD", trackingId: "T3", bucket: "BoardAgeing", state: "Inducted", edd: "2026-10-30", driverId: "", driverName: "" },
    { stationCode: "JUGD", trackingId: "T5", bucket: "BoardFailed", state: "", edd: "", driverId: "Z1", driverName: "Zero" },
    { stationCode: "JUGD", trackingId: "T6", bucket: "BoardFailed", state: "", edd: "", driverId: "B1", driverName: "Ben" },
    { stationCode: "JUGD", trackingId: "T7", bucket: "BoardDelivered", state: "", edd: "", driverId: "B1", driverName: "Ben" },
  ];
  const edd = mapBoardTidExportRows(flash, "edd");
  assert.deepEqual(edd.map((row) => row.trackingId), ["T1"]);
  assert.equal(edd[0].report, "EDD");

  const ageing = mapBoardTidExportRows(flash, "ageing");
  assert.deepEqual(ageing.map((row) => row.trackingId), ["T3"]);

  const zero = mapBoardTidExportRows(flash, "zero");
  assert.deepEqual(zero.map((row) => row.trackingId), ["T5"]);
  assert.equal(zero[0].status, "Failed");

  const sheet = boardTidSheetRows(edd);
  assert.deepEqual(Object.keys(sheet[0]), ["Station", "Report", "Tracking ID", "Status", "EDD", "DA ID", "DA Name"]);
  assert.equal(sheet[0]["Tracking ID"], "T1");
});

test("C-Return rolls picked-up Amazon states into PICKUP_DONE", () => {
  const rows = mapBoardTidExportRows(
    [
      { stationCode: "GDRD", trackingId: "P1", bucket: "BoardCReturn", state: "DELIVERED", edd: "", driverId: "", driverName: "" },
      { stationCode: "GDRD", trackingId: "P2", bucket: "BoardCReturn", state: "AT_STATION", edd: "", driverId: "", driverName: "" },
    ],
    "creturn",
  );
  assert.equal(rows.find((row) => row.trackingId === "P1")?.status, "PICKUP_DONE");
  assert.equal(rows.find((row) => row.trackingId === "P2")?.status, "AT_STATION");
});

test('C-Return fallback is selected per station so mixed snapshot generations remain visible', () => {
 const rows = mapBoardTidExportRows([
  { stationCode:'KLZA',trackingId:'1',bucket:'BoardCReturn',state:'DELAYED',driverId:'A',driverName:'A',edd:'' },
  { stationCode:'KLZA',trackingId:'1',bucket:'Pickup',state:'DELAYED',driverId:'A',driverName:'A',edd:'' },
  { stationCode:'GDRD',trackingId:'2',bucket:'Pickup',state:'AT_STATION',driverId:'B',driverName:'B',edd:'' },
 ], 'creturn');
 assert.deepEqual(rows.map(r=>r.stationCode), ['KLZA','GDRD']);
});
