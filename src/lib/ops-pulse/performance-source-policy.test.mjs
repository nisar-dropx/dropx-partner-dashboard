import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_DAILY_PERFORMANCE_SOURCE,
  selectActiveDailyBatchRows,
  selectStationDailyRow,
} from "./performance-source-policy.ts";

const fact = (source_type, batch_id, created_at, report_date = "2026-09-02", station_code = "KOZA") => ({
  batch_id,
  created_at,
  report_date,
  source_type,
  station_code,
});

test("uses Hawkeye as the active temporary daily performance source", () => {
  assert.equal(ACTIVE_DAILY_PERFORMANCE_SOURCE, "amazon_hawkeye_daily");
});

test("does not fall back to automated Daily EDSP facts", () => {
  const selected = selectActiveDailyBatchRows([
    fact("daily_edsp_metrics", "edsp-new", "2026-09-03T08:00:00Z"),
  ], "2026-09-02");
  assert.equal(selected.batchId, null);
  assert.deepEqual(selected.rows, []);
});

test("selects every station row from the latest Hawkeye batch", () => {
  const selected = selectActiveDailyBatchRows([
    fact("amazon_hawkeye_daily", "hawkeye-old", "2026-09-03T07:00:00Z"),
    fact("amazon_hawkeye_daily", "hawkeye-latest", "2026-09-03T09:00:00Z"),
    fact("amazon_hawkeye_daily", "hawkeye-latest", "2026-09-03T09:00:00Z"),
    fact("daily_edsp_metrics", "edsp-newer", "2026-09-03T10:00:00Z"),
  ], "2026-09-02");
  assert.equal(selected.batchId, "hawkeye-latest");
  assert.equal(selected.rows.length, 2);
  assert.ok(selected.rows.every((row) => row.source_type === "amazon_hawkeye_daily"));
});

test("keeps a station row when a newer Hawkeye batch omitted that station", () => {
  const norm = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rows = [
    fact("amazon_hawkeye_daily", "hawkeye-latest", "2026-09-05T10:00:00Z", "2026-09-04", "KOZA"),
    fact("amazon_hawkeye_daily", "hawkeye-old", "2026-09-05T09:00:00Z", "2026-09-04", "TLPB"),
    fact("amazon_hawkeye_daily", "hawkeye-old", "2026-09-05T09:00:00Z", "2026-09-04", "KOZA"),
  ];
  assert.equal(selectActiveDailyBatchRows(rows, "2026-09-04").rows.map((row) => row.station_code).join(","), "KOZA");
  assert.equal(selectStationDailyRow(rows, "2026-09-04", "TLPB", norm)?.station_code, "TLPB");
});
