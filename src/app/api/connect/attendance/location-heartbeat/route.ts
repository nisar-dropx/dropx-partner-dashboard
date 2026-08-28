import { NextRequest, NextResponse } from "next/server";
import {
  continuousOutsideMs,
  evaluateGeofence,
  evaluateIntegrity,
  HEARTBEAT_MIN_INTERVAL_MS,
  loadOpenShift,
  loadOutsideStationPolicy,
  loadStationGeofence,
  maybeNotifyForgotPunchOut,
  openIntegrityFlag,
  parseIntegritySignals
} from "@/lib/biometric/attendance-gps";
import { resolveStationAttendanceSettings } from "@/lib/biometric/station-attendance-settings";
import {
  parseClientSignals,
  parseCoordinate,
  parseOptionalNumber,
  resolveConnectAttendanceWorker
} from "@/lib/connect-attendance-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    if (!accountId) throw new Error("Account is required.");

    const lat = parseCoordinate(formData.get("lat"), "Latitude");
    const lng = parseCoordinate(formData.get("lng"), "Longitude");
    const accuracyM = parseOptionalNumber(formData.get("accuracyM"));
    const altitudeM = parseOptionalNumber(formData.get("altitudeM"));
    const clientCapturedAt = String(formData.get("clientCapturedAt") ?? "").trim() || null;
    const sessionId = String(formData.get("sessionId") ?? "").trim() || null;
    const integritySignals = parseIntegritySignals(parseClientSignals(formData.get("integritySignals")));

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType, requirePeopleScope: true });
    if (!worker.locationId) {
      return NextResponse.json({ ok: true, skipped: true, reason: "assigned_station_missing" });
    }
    const stationSettings = await resolveStationAttendanceSettings(worker.locationId);
    if (!stationSettings.locationTrackingEnabled) {
      return NextResponse.json({ ok: true, skipped: true, reason: "location_tracking_disabled" });
    }
    const shift = await loadOpenShift({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId
    });
    if (!shift.open || !shift.inTime) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "no_open_shift"
      });
    }
    const policy = await loadOutsideStationPolicy({
      companyId: worker.companyId,
      profileType: worker.profileType,
      profileId: worker.profileId,
      punchDate: shift.punchDate
    });
    if (!policy.enabled) {
      return NextResponse.json({ ok: true, skipped: true, reason: "outside_station_tracking_disabled" });
    }

    // Rate-limit heartbeats.
    const recent = await supabaseAdmin
      .from("attendance_location_samples")
      .select("id, server_received_at")
      .eq("company_id", worker.companyId)
      .eq("enrolment_id", worker.enrolmentId)
      .order("server_received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent.error && !String(recent.error.message).toLowerCase().includes("does not exist")) {
      throw new Error(recent.error.message);
    }
    if (recent.data?.server_received_at) {
      const elapsed = Date.now() - new Date(recent.data.server_received_at).getTime();
      if (elapsed < HEARTBEAT_MIN_INTERVAL_MS) {
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "rate_limited",
          retryAfterMs: HEARTBEAT_MIN_INTERVAL_MS - elapsed
        });
      }
    }

    const station = await loadStationGeofence(worker.locationId);
    const geofence = evaluateGeofence(lat, lng, station);
    const integrity = evaluateIntegrity(integritySignals, accuracyM);
    const serverReceivedAt = new Date().toISOString();

    const sampleInsert = await supabaseAdmin
      .from("attendance_location_samples")
      .insert({
        company_id: worker.companyId,
        enrolment_id: worker.enrolmentId,
        profile_type: worker.profileType,
        profile_id: worker.profileId,
        location_id: station?.id ?? worker.locationId,
        session_id: sessionId,
        lat,
        lng,
        accuracy_m: accuracyM,
        altitude_m: altitudeM,
        outside_zone: geofence.status === "outside",
        distance_m: geofence.distanceM,
        integrity_signals: {
          ...integritySignals,
          reasons: integrity.reasons,
          score: integrity.score
        },
        client_captured_at: clientCapturedAt,
        server_received_at: serverReceivedAt
      })
      .select("id, outside_zone, distance_m")
      .single();
    if (sampleInsert.error) {
      if (String(sampleInsert.error.message).toLowerCase().includes("does not exist")) {
        throw new Error("Attendance GPS integrity setup is pending. Run attendance_gps_integrity_v1.sql.");
      }
      throw new Error(sampleInsert.error.message);
    }

    const outsideMs = await continuousOutsideMs({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      sinceIso: shift.inTime.toISOString()
    });

    let outsideFlagId: string | null = null;
    if (outsideMs >= policy.thresholdMs) {
      const flag = await openIntegrityFlag({
        companyId: worker.companyId,
        enrolmentId: worker.enrolmentId,
        profileType: worker.profileType,
        profileId: worker.profileId,
        locationId: station?.id ?? worker.locationId,
        punchDate: shift.punchDate,
        flagType: "outside_station_over_limit",
        severity: "high",
        message: `${worker.fullName || worker.dropxId} stayed outside the assigned station beyond the allowed ${policy.effectiveAllowanceMinutes} minutes.`,
        details: {
          outsideMs,
          thresholdMs: policy.thresholdMs,
          companyAllowanceMinutes: policy.companyAllowanceMinutes,
          shiftBreakMinutes: policy.shiftBreakMinutes,
          effectiveAllowanceMinutes: policy.effectiveAllowanceMinutes,
          distanceM: geofence.distanceM,
          radiusM: geofence.radiusM,
          assignedStationId: station?.id ?? worker.locationId,
          assignedStationCode: station?.stationCode ?? null,
          assignedStationName: station?.stationName ?? null
        }
      });
      outsideFlagId = flag.id;
    }

    await maybeNotifyForgotPunchOut({
      accountId: worker.profileId,
      companyId: worker.companyId,
      profileType: worker.profileType,
      enrolmentId: worker.enrolmentId,
      punchDate: shift.punchDate,
      inTime: shift.inTime
    });

    return NextResponse.json({
      ok: true,
      sampleId: sampleInsert.data.id,
      geofence: {
        status: geofence.status,
        distanceM: geofence.distanceM,
        radiusM: geofence.radiusM
      },
      outsideMs,
      outsidePolicy: policy,
      outsideFlagId,
      shift: {
        punchDate: shift.punchDate,
        inTime: shift.inTime.toISOString(),
        open: true
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record location heartbeat.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
