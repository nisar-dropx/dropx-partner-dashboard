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
import { createAppNotification } from "@/lib/app-notifications";
import {
  parseClientSignals,
  parseCoordinate,
  parseOptionalNumber,
  resolveConnectAttendanceWorker
} from "@/lib/connect-attendance-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type PunchBody = {
  accountId?: string;
  profileType?: string;
  action?: string;
  lat?: unknown;
  lng?: unknown;
  accuracyM?: unknown;
  altitudeM?: unknown;
  clientCapturedAt?: unknown;
  integritySignals?: unknown;
  faceMatched?: unknown;
};

async function readPunchBody(request: NextRequest): Promise<PunchBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await request.json()) as PunchBody;
    return json ?? {};
  }
  const formData = await request.formData();
  return {
    accountId: String(formData.get("accountId") ?? ""),
    profileType: String(formData.get("profileType") ?? ""),
    action: String(formData.get("action") ?? ""),
    lat: formData.get("lat"),
    lng: formData.get("lng"),
    accuracyM: formData.get("accuracyM"),
    altitudeM: formData.get("altitudeM"),
    clientCapturedAt: formData.get("clientCapturedAt"),
    integritySignals: formData.get("integritySignals"),
    faceMatched: formData.get("faceMatched")
    // selfie file is intentionally ignored — face match happens on device only
  };
}

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
    const openFlags = flagsResult.data ?? [];
    // Never surface "pending approval" to the worker when there are no open flags.
    // Held punches can linger after resolve; monitoring stays server-side.
    const pendingForClient = openFlags.length > 0 && shift.pendingApproval === true;
    // Redact integrity internals — workers only need enough to submit a selfie.
    const openFlagsForClient = openFlags.map((flag) => ({
      id: flag.id,
      punch_date: flag.punch_date,
      status: flag.status,
      created_at: flag.created_at,
      flag_type: "action_needed",
      severity: "medium",
      message: "Take a live selfie at your station to continue.",
      details: {}
    }));
    return NextResponse.json({
      enrolmentId: worker.enrolmentId,
      locationId: worker.locationId,
      shift: {
        punchDate: shift.punchDate,
        open: shift.open,
        inTime: shift.inTime?.toISOString() ?? null,
        outTime: shift.outTime?.toISOString() ?? null,
        punchCount: shift.punchCount,
        pendingApproval: pendingForClient,
        dutyOnly: pendingForClient
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
      openFlags: openFlagsForClient
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
    const body = await readPunchBody(request);
    const accountId = String(body.accountId ?? "").trim();
    const profileType = String(body.profileType ?? "").trim();
    const action = String(body.action ?? "").trim().toLowerCase();
    if (!accountId) throw new Error("Account is required.");
    if (action !== "in" && action !== "out") throw new Error("Punch action must be in or out.");

    const lat = parseCoordinate(body.lat as never, "Latitude");
    const lng = parseCoordinate(body.lng as never, "Longitude");
    if (lat < -90 || lat > 90) throw new Error("Latitude is out of range.");
    if (lng < -180 || lng > 180) throw new Error("Longitude is out of range.");
    const accuracyM = parseOptionalNumber(body.accuracyM as never);
    const altitudeM = parseOptionalNumber(body.altitudeM as never);
    const clientCapturedAt = String(body.clientCapturedAt ?? "").trim() || null;
    const integritySignals = parseIntegritySignals(parseClientSignals(body.integritySignals as never));
    const faceMatched =
      body.faceMatched === true || String(body.faceMatched ?? "").trim().toLowerCase() === "true";
    if (!faceMatched) {
      throw new Error("Face match required before punching. Capture a selfie in the app circle until match is 60%+.");
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

    // Do not notify "attendance punched" — punch is held until manager approve.
    await createAppNotification({
      accountId: worker.profileId,
      companyId: worker.companyId,
      data: {
        punchId: result.punch.id,
        flagIds: result.flagIds,
        geofenceStatus: geofence.status,
        pendingApproval: true
      },
      eventCode: "attendance_location_flagged",
      profileType: worker.profileType,
      sourceKey: `gps-pending:${result.punch.id}`,
      variables: { date: String(result.punch.punch_date).split("-").reverse().join("/") }
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      punch: result.punch,
      geofence: {
        status: geofence.status,
        distanceM: geofence.distanceM,
        radiusM: geofence.radiusM,
        stationId: geofence.station?.id ?? null,
        stationCode: geofence.station?.stationCode ?? null,
        stationName: geofence.station?.stationName ?? null
      },
      integrity: {
        score: integrity.score,
        reasons: integrity.reasons
      },
      isFlagged: true,
      supportRequired: true,
      pendingApproval: true,
      flagIds: result.flagIds,
      message: "Action needed. Submit a selfie from Attendance if prompted."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record GPS punch.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
