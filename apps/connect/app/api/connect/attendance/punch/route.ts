import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import {
  evaluateIntegrity,
  insertConnectAppGpsPunch,
  loadConnectPunchStatus,
  loadOpenShift,
  mapSupabaseConfigError,
  parseClientSignals,
  parseCoordinate,
  parseIntegritySignals,
  parseOptionalNumber,
  resolveCompanyPunchGeofence
} from "@/lib/connect-app-gps-punch";

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
  };
}

function errorResponse(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : fallback;
  const message = mapSupabaseConfigError(raw);
  const status = /login|expired/i.test(message) ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    const payload = await loadConnectPunchStatus(worker);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error, "Unable to load punch status.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await readPunchBody(request);
    const accountId = String(body.accountId ?? "").trim();
    const profileType = String(body.profileType ?? "").trim();
    const action = String(body.action ?? "").trim().toLowerCase();
    if (!accountId) throw new Error("Account is required.");
    if (action !== "in" && action !== "out") throw new Error("Punch action must be in or out.");

    const lat = parseCoordinate(body.lat, "Latitude");
    const lng = parseCoordinate(body.lng, "Longitude");
    if (lat < -90 || lat > 90) throw new Error("Latitude is out of range.");
    if (lng < -180 || lng > 180) throw new Error("Longitude is out of range.");
    const accuracyM = parseOptionalNumber(body.accuracyM);
    const altitudeM = parseOptionalNumber(body.altitudeM);
    const clientCapturedAt = String(body.clientCapturedAt ?? "").trim() || null;
    const integritySignals = parseIntegritySignals(parseClientSignals(body.integritySignals));
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
    const result = await insertConnectAppGpsPunch({
      worker,
      locationId: punchLocationId,
      lat,
      lng,
      accuracyM,
      altitudeM,
      clientCapturedAt,
      integritySignals,
      geofence,
      integrity,
      faceMatched: true
    });

    return NextResponse.json({
      ok: true,
      punch: result.punch,
      geofence: {
        status: result.geofence.status,
        distanceM: result.geofence.distanceM,
        radiusM: result.geofence.radiusM,
        stationId: result.geofence.station?.id ?? null,
        stationCode: result.geofence.station?.stationCode ?? null,
        stationName: result.geofence.station?.stationName ?? null
      },
      integrity: {
        score: integrity.score,
        reasons: integrity.reasons
      },
      isFlagged: result.isFlagged,
      supportRequired: result.supportRequired,
      pendingApproval: result.pendingApproval,
      flagIds: result.flagIds,
      message: result.isFlagged
        ? "Action needed. Submit a selfie from Attendance if prompted."
        : "Punch recorded."
    });
  } catch (error) {
    return errorResponse(error, "Unable to record GPS punch.");
  }
}
