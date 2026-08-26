import { NextRequest, NextResponse } from "next/server";
import {
  evaluateIntegrity,
  insertAppGpsPunch,
  loadCompanyStationGeofences,
  loadOpenShift,
  loadStationGeofence,
  parseIntegritySignals,
  resolveCompanyPunchGeofence
} from "@/lib/biometric/attendance-gps";
import { createAttendancePunchNotification, createAppNotification } from "@/lib/app-notifications";
import {
  parseClientSignals,
  parseCoordinate,
  parseOptionalNumber,
  resolveConnectAttendanceWorker
} from "@/lib/connect-attendance-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    const shift = await loadOpenShift({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId
    });
    const assignedStation = await loadStationGeofence(worker.locationId ?? shift.locationId);
    const companyStations = await loadCompanyStationGeofences(worker.companyId);
    const flagsResult = await supabaseAdmin
      .from("attendance_integrity_flags")
      .select("id, flag_type, severity, message, status, punch_date, created_at, details")
      .eq("company_id", worker.companyId)
      .eq("enrolment_id", worker.enrolmentId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(20);
    if (flagsResult.error && !String(flagsResult.error.message).toLowerCase().includes("does not exist")) {
      throw new Error(flagsResult.error.message);
    }
    const stations = companyStations.length
      ? companyStations
      : assignedStation
        ? [assignedStation]
        : [];
    return NextResponse.json({
      enrolmentId: worker.enrolmentId,
      locationId: worker.locationId,
      shift: {
        punchDate: shift.punchDate,
        open: shift.open,
        inTime: shift.inTime?.toISOString() ?? null,
        outTime: shift.outTime?.toISOString() ?? null,
        punchCount: shift.punchCount
      },
      station: assignedStation
        ? {
            id: assignedStation.id,
            code: assignedStation.stationCode,
            name: assignedStation.stationName,
            latitude: assignedStation.latitude,
            longitude: assignedStation.longitude,
            radiusM: assignedStation.geofenceRadiusM
          }
        : null,
      stations: stations.map((row) => ({
        id: row.id,
        code: row.stationCode,
        name: row.stationName,
        latitude: row.latitude,
        longitude: row.longitude,
        radiusM: row.geofenceRadiusM
      })),
      openFlags: flagsResult.data ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load punch status.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const action = String(formData.get("action") ?? "").trim().toLowerCase();
    if (!accountId) throw new Error("Account is required.");
    if (action !== "in" && action !== "out") throw new Error("Punch action must be in or out.");

    const lat = parseCoordinate(formData.get("lat"), "Latitude");
    const lng = parseCoordinate(formData.get("lng"), "Longitude");
    if (lat < -90 || lat > 90) throw new Error("Latitude is out of range.");
    if (lng < -180 || lng > 180) throw new Error("Longitude is out of range.");
    const accuracyM = parseOptionalNumber(formData.get("accuracyM"));
    const altitudeM = parseOptionalNumber(formData.get("altitudeM"));
    const clientCapturedAt = String(formData.get("clientCapturedAt") ?? "").trim() || null;
    const integritySignals = parseIntegritySignals(parseClientSignals(formData.get("integritySignals")));
    const faceMatched = String(formData.get("faceMatched") ?? "").trim().toLowerCase() === "true";
    if (!faceMatched) {
      throw new Error("Selfie must match your profile photo before punching.");
    }

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    const shift = await loadOpenShift({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId
    });
    if (action === "in" && shift.open) {
      throw new Error("You already have an open punch-in. Punch out first.");
    }
    if (action === "out" && !shift.open) {
      throw new Error("No open punch-in found for today. Punch in first.");
    }

    const geofence = await resolveCompanyPunchGeofence({
      companyId: worker.companyId,
      lat,
      lng,
      preferredLocationId: worker.locationId ?? shift.locationId
    });
    const integrity = evaluateIntegrity(integritySignals, accuracyM);

    // Soft-block strong spoof signals on web when client reports them (Flutter will hard-block).
    if (integritySignals.mockLocation === true || integritySignals.developerMode === true) {
      throw new Error(
        "Turn off mock location / developer options before punching. Fake GPS is not allowed."
      );
    }

    const punchLocationId = geofence.station?.id ?? worker.locationId;
    const result = await insertAppGpsPunch({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      workerType: worker.workerType,
      profileType: worker.profileType,
      profileId: worker.profileId,
      employeeId: worker.employeeId,
      fieldExecutiveId: worker.fieldExecutiveId,
      locationId: punchLocationId,
      lat,
      lng,
      accuracyM,
      altitudeM,
      selfiePath: null,
      clientCapturedAt,
      integritySignals,
      geofence,
      integrity,
      faceMatched: true
    });

    const punchOrder = Number(result.punch.punch_order ?? 1);
    const punchTime = new Date(String(result.punch.punch_time));
    await createAttendancePunchNotification({
      accountId: worker.profileId,
      companyId: worker.companyId,
      firstPunchTime: shift.inTime ?? punchTime,
      profileType: worker.profileType,
      punchDate: String(result.punch.punch_date),
      punchId: String(result.punch.id),
      punchOrder,
      punchTime
    }).catch(() => undefined);

    if (result.isFlagged) {
      await createAppNotification({
        accountId: worker.profileId,
        companyId: worker.companyId,
        data: {
          punchId: result.punch.id,
          flagIds: result.flagIds,
          geofenceStatus: geofence.status
        },
        eventCode: "attendance_location_flagged",
        profileType: worker.profileType,
        sourceKey: `gps-flag:${result.punch.id}`,
        variables: { date: String(result.punch.punch_date).split("-").reverse().join("/") }
      }).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true,
      punch: result.punch,
      geofence: {
        status: geofence.status,
        distanceM: geofence.distanceM,
        radiusM: geofence.radiusM
      },
      integrity: {
        score: integrity.score,
        reasons: integrity.reasons
      },
      isFlagged: result.isFlagged,
      supportRequired: result.supportRequired,
      flagIds: result.flagIds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record GPS punch.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
