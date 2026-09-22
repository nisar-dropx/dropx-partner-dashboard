import { NextRequest, NextResponse } from "next/server";
import { loadOpenShift, openIntegrityFlag } from "@/lib/biometric/attendance-gps";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-auth";

export const dynamic = "force-dynamic";

/**
 * Two distinct client-reported problems land here, both best-effort and after-the-fact —
 * there's no way for the server to independently confirm either from its own side:
 *
 * 1. gapMinutes set (no reasonCode): reported by MainActivity's TrackingInterruptionReporter
 *    when it reopens and finds background location tracking should have been running (per its
 *    own last-known state) but LocationTrackingService's last successful heartbeat is stale
 *    beyond the expected interval — the signature of the service having been killed by a
 *    force-stop, an OEM battery manager, or a crash, none of which Android lets a foreground
 *    service survive or self-report from inside the dying process.
 * 2. reasonCode set (location_off / internet_off): reported by LocationTrackingService's
 *    repeating integrity-check loop (runIntegrityCheck()) on every tick a problem persists —
 *    NOT a one-time event, so unlike case 1 this can call openIntegrityFlag() repeatedly for
 *    the same open shift; openIntegrityFlag() itself already updates an existing open flag of
 *    the same type/punch_date in place rather than creating duplicates (see its own upsert-like
 *    handling), so repeated calls just refresh one flag's timestamp/message, not spam new ones.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const gapMinutes = Number(formData.get("gapMinutes") ?? 0);
    const reasonCode = String(formData.get("reasonCode") ?? "").trim();
    const reasonLabel = String(formData.get("reasonLabel") ?? "").trim();
    if (!accountId) throw new Error("Account is required.");
    const hasGap = Number.isFinite(gapMinutes) && gapMinutes > 0;
    if (!hasGap && !reasonCode) throw new Error("Either a positive gapMinutes or a reasonCode is required.");

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType, requirePeopleScope: true });
    if (!worker.locationId) {
      return NextResponse.json({ ok: true, skipped: true, reason: "assigned_station_missing" });
    }
    const shift = await loadOpenShift({ companyId: worker.companyId, enrolmentId: worker.enrolmentId });
    if (!shift.inTime) {
      // Nothing to flag against — no open shift means there's no attendance this could put at risk.
      return NextResponse.json({ ok: true, skipped: true, reason: "no_punch_in" });
    }

    const message = hasGap
      ? `${worker.fullName || worker.dropxId}'s location tracking stopped unexpectedly for about ${Math.round(gapMinutes)} minutes during an open shift — continuing this will mark today's attendance absent.`
      : `${worker.fullName || worker.dropxId}'s device reported "${reasonLabel || reasonCode}" during an open shift — continuing this will mark today's attendance absent.`;

    const flag = await openIntegrityFlag({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      profileType: worker.profileType,
      profileId: worker.profileId,
      locationId: worker.locationId,
      punchDate: shift.punchDate,
      flagType: "integrity_risk",
      severity: "high",
      message,
      details: hasGap
        ? { reasons: ["tracking_interrupted"], gapMinutes: Math.round(gapMinutes) }
        : { reasons: [reasonCode], reasonLabel }
    });

    return NextResponse.json({ ok: true, flagId: flag.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record tracking interruption.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
