import { NextResponse } from "next/server";
import { loadAttendanceCatchupAudit } from "@/lib/biometric/attendance-catchup-audit";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }

  try {
    const audit = await loadAttendanceCatchupAudit();
    console.info(JSON.stringify({
      event: "attendance_catchup_audit_completed",
      durationMs: Date.now() - startedAtMs,
      ...audit
    }));
    return NextResponse.json(audit, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to audit attendance catch-up.";
    console.error(JSON.stringify({
      event: "attendance_catchup_audit_failed",
      durationMs: Date.now() - startedAtMs,
      message
    }));
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
