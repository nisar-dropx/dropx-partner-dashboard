import { NextResponse } from "next/server";
import { reconcileBiometricAttendance } from "@/lib/biometric/attendance-reconciliation";
import {
  ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  ATTENDANCE_RECONCILIATION_MAX_BATCH_SIZE,
  parsePositiveInteger,
  resolveAttendanceReconciliationWindow
} from "@/lib/biometric/attendance-reconciliation-policy";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;
const SHA256 = /^[0-9a-f]{64}$/i;

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const catchup = url.searchParams.get("mode") === "catchup";
    const rawActivityOnlyValue = url.searchParams.get("raw_activity_only");
    if (rawActivityOnlyValue !== null && rawActivityOnlyValue !== "true") {
      throw new Error("Attendance reconciliation raw_activity_only must be true when provided.");
    }
    const rawActivityOnly = rawActivityOnlyValue === "true";
    const expectedSnapshotValue = url.searchParams.get("expected_snapshot");
    if (expectedSnapshotValue !== null && !SHA256.test(expectedSnapshotValue)) {
      throw new Error("Attendance reconciliation expected_snapshot is invalid.");
    }
    const window = resolveAttendanceReconciliationWindow({
      catchup,
      fromDate: url.searchParams.get("from"),
      toDate: url.searchParams.get("to")
    });
    const batchSize = parsePositiveInteger(url.searchParams.get("limit"), {
      fallback: catchup ? 8 : ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
      maximum: ATTENDANCE_RECONCILIATION_MAX_BATCH_SIZE
    });
    const cursor = url.searchParams.has("cursor")
      ? parsePositiveInteger(url.searchParams.get("cursor"), {
          fallback: 0,
          maximum: 10_000_000,
          minimum: 0
        })
      // A requested historical replay must begin at the first mapping. The
      // rotating cursor is only for the scheduled rolling reconciliation.
      : catchup ? 0 : null;
    const result = await reconcileBiometricAttendance({
      batchSize,
      cursor,
      deadlineAtMs: startedAtMs + (maxDuration - 45) * 1000,
      expectedSnapshotToken: expectedSnapshotValue?.toLowerCase() ?? null,
      fromDate: window.fromDate,
      rawActivityOnly,
      serializeByCompany: true,
      toDate: window.toDate
    });
    const log = {
      event: result.failures.length
        ? "attendance_reconciliation_completed_with_retries"
        : "attendance_reconciliation_completed",
      durationMs: Date.now() - startedAtMs,
      ...result
    };
    if (result.failures.length) console.warn(JSON.stringify(log));
    else console.info(JSON.stringify(log));
    return NextResponse.json(
      { ...result, healthy: result.failures.length === 0 },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reconcile biometric attendance.";
    console.error(JSON.stringify({
      event: "attendance_reconciliation_failed",
      durationMs: Date.now() - startedAtMs,
      message
    }));
    const status = /changed during repair/i.test(message)
      ? 409
      : /date|range|pagination|mode=catchup|raw_activity_only|expected_snapshot/i.test(message) ? 400 : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
