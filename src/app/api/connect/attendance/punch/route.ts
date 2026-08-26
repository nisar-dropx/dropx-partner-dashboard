import { NextRequest, NextResponse } from "next/server";
import {
  evaluateGeofence,
  evaluateIntegrity,
  insertAppGpsPunch,
  loadOpenShift,
  loadStationGeofence,
  parseIntegritySignals
} from "@/lib/biometric/attendance-gps";
import { createAttendancePunchNotification, createAppNotification } from "@/lib/app-notifications";
import {
  fileExtension,
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
    const station = await loadStationGeofence(worker.locationId ?? shift.locationId);
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
      station: station
        ? {
            id: station.id,
            code: station.stationCode,
            name: station.stationName,
            latitude: station.latitude,
            longitude: station.longitude,
            radiusM: station.geofenceRadiusM
          }
        : null,
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

    const selfie = formData.get("selfie");
    if (!(selfie instanceof File) || selfie.size <= 0) {
      throw new Error("Selfie is required for app GPS punch.");
    }
    if (selfie.size > 8 * 1024 * 1024) throw new Error("Selfie must be 8 MB or smaller.");
    if (!navigatorOnlineHint(formData)) {
      // Client must confirm online; server still accepts if request arrived.
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

    const station = await loadStationGeofence(worker.locationId ?? shift.locationId);
    const geofence = evaluateGeofence(lat, lng, station);
    const integrity = evaluateIntegrity(integritySignals, accuracyM);

    // Soft-block strong spoof signals on web when client reports them (Flutter will hard-block).
    if (integritySignals.mockLocation === true || integritySignals.developerMode === true) {
      throw new Error(
        "Turn off mock location / developer options before punching. Fake GPS is not allowed."
      );
    }

    const safeName = selfie.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "selfie.jpg";
    const selfiePath = `${worker.companyId}/${worker.profileId}/attendance-selfie-${Date.now()}${fileExtension(safeName) || ".jpg"}`;
    const uploadResult = await supabaseAdmin.storage
      .from("employee-profile-documents")
      .upload(selfiePath, Buffer.from(await selfie.arrayBuffer()), {
        contentType: selfie.type || "image/jpeg",
        upsert: false
      });
    if (uploadResult.error) throw new Error(uploadResult.error.message);

    const result = await insertAppGpsPunch({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      workerType: worker.workerType,
      profileType: worker.profileType,
      profileId: worker.profileId,
      employeeId: worker.employeeId,
      fieldExecutiveId: worker.fieldExecutiveId,
      locationId: worker.locationId,
      lat,
      lng,
      accuracyM,
      altitudeM,
      selfiePath,
      clientCapturedAt,
      integritySignals,
      geofence,
      integrity
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

function navigatorOnlineHint(_formData: FormData) {
  return true;
}
