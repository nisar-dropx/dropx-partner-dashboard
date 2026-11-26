import test from "node:test";
import assert from "node:assert/strict";
import {
  istWallClockMs,
  nearestSnapshotBefore,
  parseSiteSummaryAsOf,
  shouldArchiveSiteSummaryHistory,
  siteSummaryArchiveSignature
} from "./ds-site-summary-history.ts";

test("nearestSnapshotBefore picks newest at or before asOf", () => {
  const rows = [
    { id: "a", fetched_at: "2026-11-25T08:00:00.000Z" },
    { id: "b", fetched_at: "2026-11-25T08:30:00.000Z" },
    { id: "c", fetched_at: "2026-11-25T09:00:00.000Z" }
  ];
  const asOf = Date.parse("2026-11-25T08:45:00.000Z");
  assert.equal(nearestSnapshotBefore(rows, asOf)?.id, "b");
});

test("nearestSnapshotBefore returns null when all rows are after asOf", () => {
  const rows = [{ id: "a", fetched_at: "2026-11-25T10:00:00.000Z" }];
  assert.equal(nearestSnapshotBefore(rows, Date.parse("2026-11-25T09:00:00.000Z")), null);
});

test("parseSiteSummaryAsOf treats bare wall clock as IST", () => {
  const ms = parseSiteSummaryAsOf("2026-11-25T14:00");
  assert.equal(ms, istWallClockMs("2026-11-25", 14, 0));
  // 14:00 IST = 08:30 UTC
  assert.equal(new Date(ms).toISOString(), "2026-11-25T08:30:00.000Z");
});

test("shouldArchiveSiteSummaryHistory archives on material change even inside interval", () => {
  assert.equal(
    shouldArchiveSiteSummaryHistory({
      lastArchivedAtMs: Date.now() - 30_000,
      nowMs: Date.now(),
      minIntervalMs: 120_000,
      previousSignature: "1|0|5|2|1",
      nextSignature: "2|1|5|2|1"
    }),
    true
  );
});

test("shouldArchiveSiteSummaryHistory waits for interval when signature unchanged", () => {
  const now = Date.now();
  assert.equal(
    shouldArchiveSiteSummaryHistory({
      lastArchivedAtMs: now - 30_000,
      nowMs: now,
      minIntervalMs: 120_000,
      previousSignature: "1|0|5|2|1",
      nextSignature: "1|0|5|2|1"
    }),
    false
  );
  assert.equal(
    shouldArchiveSiteSummaryHistory({
      lastArchivedAtMs: now - 180_000,
      nowMs: now,
      minIntervalMs: 120_000,
      previousSignature: "1|0|5|2|1",
      nextSignature: "1|0|5|2|1"
    }),
    true
  );
});

test("siteSummaryArchiveSignature is stable", () => {
  assert.equal(
    siteSummaryArchiveSignature({
      activeOrders: 3,
      pendingAcceptance: 1,
      totalAssociates: 12,
      waitingForOrders: 4,
      picking: 5
    }),
    "3|1|12|4|5"
  );
});
