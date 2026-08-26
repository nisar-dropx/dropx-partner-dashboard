import { NextRequest, NextResponse } from "next/server";
import {
  continuousOutsideMs,
  evaluateIntegrity,
  HEARTBEAT_MIN_INTERVAL_MS,
  loadOpenShift,
  maybeNotifyForgotPunchOut,
  openIntegrityFlag,
  OUTSIDE_CONTINUOUS_MS,
  parseIntegritySignals,
  resolveCompanyPunchGeofence
} from "@/lib/biometric/attendance-gps";
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

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
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

    const geofence = await resolveCompanyPunchGeofence({
      companyId: worker.companyId,
      lat,
      lng,
      preferredLocationId: worker.locationId ?? shift.locationId
    });
    const integrity = evaluateIntegrity(integritySignals, accuracyM);
    const serverReceivedAt = new Date().toISOString();
    const sampleLocationId = geofence.station?.id ?? worker.locationId;

    const sampleInsert = await supabaseAdmin
      .from("attendance_location_samples")
      .insert({
        company_id: worker.companyId,
        enrolment_id: worker.enrolmentId,
        profile_type: worker.profileType,
        profile_id: worker.profileId,
        location_id: sampleLocationId,
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
    if (outsideMs >= OUTSIDE_CONTINUOUS_MS) {
      const outsideMinutes = Math.round(outsideMs / 60000);
      const stationLabel =
        geofence.station?.stationCode || geofence.station?.stationName || "station";
      const distanceLabel = geofence.distanceM != null ? `${Math.round(geofence.distanceM)}m` : "unknown distance";
      const allowedLabel = geofence.radiusM != null ? `${geofence.radiusM}m` : "50m";
      const flag = await openIntegrityFlag({
        companyId: worker.companyId,
        enrolmentId: worker.enrolmentId,
        profileType: worker.profileType,
        profileId: worker.profileId,
        locationId: sampleLocationId,
        punchDate: shift.punchDate,
        flagType: "outside_geofence_gt_2h",
        severity: "high",
        message: `Outside ${stationLabel} for ${outsideMinutes} min · device ${distanceLabel} away (allowed ${allowedLabel}).`,
        details: {
          outsideMs,
          outsideMinutes,
          thresholdMs: OUTSIDE_CONTINUOUS_MS,
          thresholdMinutes: 30,
          distanceM: geofence.distanceM,
          radiusM: geofence.radiusM,
          lat,
          lng,
          accuracyM,
          stationId: geofence.station?.id ?? sampleLocationId,
          stationCode: geofence.station?.stationCode ?? null,
          stationName: geofence.station?.stationName ?? null,
          reason: "continuous_outside_geofence"
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
