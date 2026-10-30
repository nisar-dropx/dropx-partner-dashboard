import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  buildRecurringRosterRows,
  buildRecurringRosterWorkbook,
  parseRosterExportFormat,
  parseRosterExportStationIds,
  safeRosterFilename
} from "./roster-template-export.ts";

const sampleInput = {
  stations: [
    { id: "s1", station_code: "TCC3", station_name: "Thrissur" },
    { id: "s2", station_code: "EKM1", station_name: "Ernakulam" }
  ],
  people: [{
    id: "p1",
    workerType: "employee",
    code: "DX001",
    name: "Ada",
    designation: "DA",
    locationId: "s1"
  }],
  shifts: [{ id: "sh1", code: "GEN", name: "General", start_time: "09:00:00", end_time: "18:00:00" }],
  entries: [{
    worker_type: "employee",
    worker_id: "p1",
    roster_date: "2026-10-26",
    day_type: "working",
    shift_id: "sh1",
    location_id: "s1"
  }, {
    worker_type: "employee",
    worker_id: "p1",
    roster_date: "2026-10-27",
    day_type: "weekly_off",
    shift_id: null,
    location_id: "s1"
  }],
  periods: [
    { stationId: "s1", periodStart: "2026-10-26" },
    { stationId: "s2", periodStart: "2026-10-26" }
  ],
  today: "2026-10-30",
  fallbackPeriodStart: "2026-10-26"
};

test("safe roster filename strips unsafe characters", () => {
  assert.equal(safeRosterFilename("TCC3 / North"), "TCC3-North");
  assert.equal(safeRosterFilename("@@@"), "roster");
});

test("export format parser accepts pdf and excel aliases", () => {
  assert.equal(parseRosterExportFormat("pdf"), "pdf");
  assert.equal(parseRosterExportFormat("xlsx"), "xlsx");
  assert.equal(parseRosterExportFormat("excel"), "xlsx");
  assert.equal(parseRosterExportFormat(null), "xlsx");
  assert.throws(() => parseRosterExportFormat("csv"), /PDF or Excel/);
});

test("station id parser de-duplicates comma and repeated params", () => {
  const params = new URLSearchParams("stations=a,b&stations=b&stations=c");
  assert.deepEqual(parseRosterExportStationIds(params), ["a", "b", "c"]);
});

test("rows include every selected station and day codes", () => {
  const rows = buildRecurringRosterRows(sampleInput);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].LOCATION_CODE, "EKM1");
  assert.equal(rows[0].NAME, "(No active people assigned)");
  assert.equal(rows[1].LOCATION_CODE, "TCC3");
  assert.equal(rows[1].DROPX_ID, "DX001");
  assert.equal(rows[1].MONDAY, "GEN");
  assert.equal(rows[1].TUESDAY, "WO");
});

test("workbook includes every station even when a station has no people", () => {
  const bytes = buildRecurringRosterWorkbook(sampleInput);
  const workbook = XLSX.read(bytes, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["Recurring Roster", "Shift Master", "Instructions"]);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Recurring Roster"], { defval: "" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].LOCATION_CODE, "EKM1");
  assert.equal(rows[1].MONDAY, "GEN");
  assert.match(String(workbook.Sheets.Instructions.A1.v), /multi-station/i);
});
