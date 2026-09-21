import { NextRequest, NextResponse } from "next/server";
import { loadOpenShift, openIntegrityFlag } from "@/lib/biometric/attendance-gps";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-auth";

export const dynamic = "force-dynamic";

/**
 * Reported by the Android app's MainActivity (checkForTrackingInterruption) when it reopens
 * and finds background location tracking should have been running (per its own last-known
 * state) but LocationTrackingService's last successful heartbeat is stale beyond the expected
 * interval — the signature of the service having been killed by a force-stop, an OEM battery
 * manager, or a crash, none of which Android lets a foreground service survive or self-report
 * from inside the dying process. This is a best-effort, after-the-fact report from the SAME
 * device that experienced the gap, not a server-side detection — there's no way for the
 * server to independently confirm a gap the client simply stopped posting during.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const gapMinutes = Number(formData.get("gapMinutes") ?? 0);
    if (!accountId) throw new Error("Account is required.");
    if (!Number.isFinite(gapMinutes) || gapMinutes <= 0) throw new Error("A positive gapMinutes is required.");

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType, requirePeopleScope: true });
    if (!worker.locationId) {
      return NextResponse.json({ ok: true, skipped: true, reason: "assigned_station_missing" });
    }
    const shift = await loadOpenShift({ companyId: worker.companyId, enrolmentId: worker.enrolmentId });
    if (!shift.inTime) {
      // Nothing to flag against — no open shift means there's no attendance this could put at risk.
      return NextResponse.json({ ok: true, skipped: true, reason: "no_punch_in" });
    }

    const flag = await openIntegrityFlag({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      profileType: worker.profileType,
      profileId: worker.profileId,
      locationId: worker.locationId,
      punchDate: shift.punchDate,
      flagType: "integrity_risk",
      severity: "high",
      message: `${worker.fullName || worker.dropxId}'s location tracking stopped unexpectedly for about ${Math.round(gapMinutes)} minutes during an open shift — continuing this will mark today's attendance absent.`,
      details: {
        reasons: ["tracking_interrupted"],
        gapMinutes: Math.round(gapMinutes)
      }
    });

    return NextResponse.json({ ok: true, flagId: flag.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record tracking interruption.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
