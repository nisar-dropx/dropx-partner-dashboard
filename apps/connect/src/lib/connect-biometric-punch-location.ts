import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ConnectAttendanceWorker } from "@/lib/connect-attendance-worker";

export const BIOMETRIC_PUNCH_CORRELATION_WINDOW_MS = 3 * 60 * 1000;
const FALLBACK_GEOFENCE_RADIUS_M = 50;

type StationGeofence = {
  id: string;
  stationCode: string | null;
  stationName: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;
};

type GeofenceEvaluation = {
  status: "inside" | "outside" | "unknown";
  distanceM: number | null;
  radiusM: number;
  station: StationGeofence | null;
};

function toNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function evaluateGeofence(lat: number, lng: number, station: StationGeofence | null): GeofenceEvaluation {
  const radiusM = station?.geofenceRadiusM ?? null;
  if (!station || station.latitude == null || station.longitude == null || radiusM == null || radiusM <= 0) {
    return {
      status: "unknown",
      distanceM:
        station?.latitude != null && station?.longitude != null
          ? Math.round(haversineMeters(lat, lng, station.latitude, station.longitude) * 100) / 100
          : null,
      radiusM: radiusM ?? FALLBACK_GEOFENCE_RADIUS_M,
      station
    };
  }
  const distanceM = Math.round(haversineMeters(lat, lng, station.latitude, station.longitude) * 100) / 100;
  return {
    status: distanceM <= radiusM ? "inside" : "outside",
    distanceM,
    radiusM,
    station
  };
}

async function loadStationGeofence(locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, latitude, longitude, geofence_radius_m")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return {
    id: String(result.data.id),
    stationCode: result.data.station_code as string | null,
    stationName: result.data.station_name as string | null,
    latitude: toNumber(result.data.latitude),
    longitude: toNumber(result.data.longitude),
    geofenceRadiusM: toNumber(result.data.geofence_radius_m)
  } satisfies StationGeofence;
}

async function loadCompanyStationGeofences(companyId: string) {
  if (!supabaseAdmin) return [] as StationGeofence[];
  const result = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, latitude, longitude, geofence_radius_m")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (result.error) return [];
  return (result.data ?? []).map((row) => ({
    id: String(row.id),
    stationCode: row.station_code as string | null,
    stationName: row.station_name as string | null,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    geofenceRadiusM: toNumber(row.geofence_radius_m)
  }));
}

async function resolveCompanyPunchGeofence({
  companyId,
  lat,
  lng,
  preferredLocationId
}: {
  companyId: string;
  lat: number;
  lng: number;
  preferredLocationId?: string | null;
}): Promise<GeofenceEvaluation> {
  const stations = await loadCompanyStationGeofences(companyId);
  if (!stations.length) {
    const preferred = await loadStationGeofence(preferredLocationId);
    return evaluateGeofence(lat, lng, preferred);
  }
  const preferred = stations.find((row) => row.id === preferredLocationId) ?? null;
  if (preferred) {
    const preferredEval = evaluateGeofence(lat, lng, preferred);
    if (preferredEval.status === "inside") return preferredEval;
  }
  let best: GeofenceEvaluation | null = null;
  for (const station of stations) {
    const evaluation = evaluateGeofence(lat, lng, station);
    if (evaluation.status === "inside") return evaluation;
    if (!best || (evaluation.distanceM ?? Number.POSITIVE_INFINITY) < (best.distanceM ?? Number.POSITIVE_INFINITY)) {
      best = evaluation;
    }
  }
  return best ?? evaluateGeofence(lat, lng, preferred);
}

async function resolveStationIntegrityFlagsEnabled(locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) return false;
  const result = await supabaseAdmin
    .from("stations")
    .select("attendance_integrity_flags_enabled")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error) return false;
  return result.data?.attendance_integrity_flags_enabled === true;
}

async function rebuildAttendanceDay(companyId: string, enrolmentId: string, punchDate: string) {
  if (!supabaseAdmin) return;
  const punchesResult = await supabaseAdmin
    .from("attendance_punches")
    .select("punch_time")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("calculated", true)
    .order("punch_time", { ascending: true });
  if (punchesResult.error) return;
  const times = (punchesResult.data ?? []).map((row) => row.punch_time).filter(Boolean) as string[];
  const first = times[0] ?? null;
  const last = times.length > 1 ? times[times.length - 1] : null;
  await supabaseAdmin.from("attendance_daily").upsert({
    company_id: companyId,
    enrolment_id: enrolmentId,
    punch_date: punchDate,
    in_time: first,
    out_time: last && last !== first ? last : null,
    punch_count: times.length,
    status: times.length ? "P" : "A",
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,enrolment_id,punch_date" });
}

async function holdAttendancePunch(punchId: string) {
  if (!supabaseAdmin) return false;
  const punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_time")
    .eq("id", punchId)
    .maybeSingle();
  if (!punch.data) return false;
  const update = await supabaseAdmin
    .from("attendance_punches")
    .update({
      calculated: false,
      is_flagged: true,
      ...(punch.data.punch_time ? { punch_time: punch.data.punch_time } : {})
    })
    .eq("id", punchId);
  return !update.error;
}

async function openIntegrityFlag({
  companyId,
  enrolmentId,
  profileType,
  profileId,
  punchId,
  locationId,
  punchDate,
  flagType,
  message,
  details = {},
  severity = "medium"
}: {
  companyId: string;
  enrolmentId: string;
  profileType?: string | null;
  profileId?: string | null;
  punchId?: string | null;
  locationId?: string | null;
  punchDate: string;
  flagType: "outside_geofence_punch" | "biometric_phone_mismatch";
  message: string;
  details?: Record<string, unknown>;
  severity?: "low" | "medium" | "high";
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("flag_type", flagType)
    .eq("status", "open")
    .maybeSingle();
  if (existing.data?.id) {
    await supabaseAdmin
      .from("attendance_integrity_flags")
      .update({ message, details, severity, punch_id: punchId ?? null, location_id: locationId ?? null, updated_at: now })
      .eq("id", existing.data.id);
    return { id: String(existing.data.id), created: false };
  }
  const insert = await supabaseAdmin
    .from("attendance_integrity_flags")
    .insert({
      company_id: companyId,
      enrolment_id: enrolmentId,
      profile_type: profileType ?? null,
      profile_id: profileId ?? null,
      punch_id: punchId ?? null,
      location_id: locationId ?? null,
      punch_date: punchDate,
      flag_type: flagType,
      severity,
      message,
      details,
      status: "open",
      updated_at: now
    })
    .select("id")
    .single();
  if (insert.error) throw new Error(insert.error.message);
  return { id: String(insert.data.id), created: true };
}

async function notifyLocationFlagged({
  accountId,
  companyId,
  profileType,
  punchDate,
  punchId,
  flagId,
  sourceKey
}: {
  accountId: string;
  companyId: string;
  profileType: string;
  punchDate: string;
  punchId: string;
  flagId: string;
  sourceKey: string;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("mob_app_notifications").upsert({
    body: `Attendance on ${punchDate.split("-").reverse().join("/")} needs review.`,
    company_id: companyId,
    data: { punchDate, punchId, flagId },
    event_code: "attendance_location_flagged",
    push_status: "not_configured",
    recipient_account_id: accountId,
    recipient_profile_type: profileType,
    route: "attendance",
    source_key: sourceKey,
    title: "Location review needed"
  }, {
    ignoreDuplicates: true,
    onConflict: "company_id,event_code,source_key,recipient_account_id"
  });
}

async function loadPunchCorrelatedSample({
  companyId,
  enrolmentId,
  punchId
}: {
  companyId: string;
  enrolmentId: string;
  punchId: string;
}) {
  if (!supabaseAdmin) return null;
  const sample = await supabaseAdmin
    .from("attendance_location_samples")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .filter("integrity_signals->>punchId", "eq", punchId)
    .limit(1)
    .maybeSingle();
  if (sample.error) return null;
  return sample.data ?? null;
}

export async function loadLatestBiometricPunchNeedingLocation(worker: ConnectAttendanceWorker, punchDate: string) {
  if (!supabaseAdmin) return null;
  const integrityEnabled = await resolveStationIntegrityFlagsEnabled(worker.locationId);
  if (!integrityEnabled) return null;

  const latestBioResult = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_time, source")
    .eq("company_id", worker.companyId)
    .eq("enrolment_id", worker.enrolmentId)
    .eq("punch_date", punchDate)
    .eq("source", "biometric")
    .order("punch_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestBioResult.error || !latestBioResult.data?.id || !latestBioResult.data.punch_time) return null;

  const correlated = await loadPunchCorrelatedSample({
    companyId: worker.companyId,
    enrolmentId: worker.enrolmentId,
    punchId: String(latestBioResult.data.id)
  });
  return {
    id: String(latestBioResult.data.id),
    punchTime: String(latestBioResult.data.punch_time),
    needsLocation: !correlated?.id
  };
}

export async function recordBiometricPunchLocation({
  worker,
  punchId,
  lat,
  lng,
  accuracyM,
  altitudeM,
  clientCapturedAt,
  sessionId,
  integritySignals = {}
}: {
  worker: ConnectAttendanceWorker;
  punchId: string;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  altitudeM?: number | null;
  clientCapturedAt?: string | null;
  sessionId?: string | null;
  integritySignals?: Record<string, unknown>;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");

  const integrityEnabled = await resolveStationIntegrityFlagsEnabled(worker.locationId);
  if (!integrityEnabled) {
    return { ok: true as const, skipped: true as const, reason: "integrity_flags_disabled" };
  }

  const punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_date, punch_time, location_id, source")
    .eq("id", punchId)
    .eq("company_id", worker.companyId)
    .eq("enrolment_id", worker.enrolmentId)
    .maybeSingle();
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data) throw new Error("Punch not found.");
  if (String(punch.data.source ?? "biometric") !== "biometric") {
    return { ok: true as const, skipped: true as const, reason: "not_biometric_punch" };
  }

  const punchTimeMs = new Date(String(punch.data.punch_time)).getTime();
  const ageMs = Date.now() - punchTimeMs;
  if (!Number.isFinite(punchTimeMs) || ageMs < 0 || ageMs > BIOMETRIC_PUNCH_CORRELATION_WINDOW_MS) {
    throw new Error("Punch location must be reported within a few minutes of the biometric punch.");
  }

  const existing = await loadPunchCorrelatedSample({
    companyId: worker.companyId,
    enrolmentId: worker.enrolmentId,
    punchId
  });
  if (existing?.id) {
    return { ok: true as const, skipped: true as const, reason: "already_recorded" as const, sampleId: String(existing.id) };
  }

  const preferredLocationId = worker.locationId ?? (punch.data.location_id as string | null);
  const geofence = await resolveCompanyPunchGeofence({
    companyId: worker.companyId,
    lat,
    lng,
    preferredLocationId
  });
  const serverReceivedAt = new Date().toISOString();
  const punchDate = String(punch.data.punch_date);

  const sampleInsert = await supabaseAdmin
    .from("attendance_location_samples")
    .insert({
      company_id: worker.companyId,
      enrolment_id: worker.enrolmentId,
      profile_type: worker.profileType,
      profile_id: worker.profileId,
      location_id: geofence.station?.id ?? preferredLocationId,
      session_id: sessionId,
      lat,
      lng,
      accuracy_m: accuracyM ?? null,
      altitude_m: altitudeM ?? null,
      outside_zone: geofence.status === "outside",
      distance_m: geofence.distanceM,
      integrity_signals: {
        ...integritySignals,
        punchId,
        mode: "biometric_punch_correlation"
      },
      client_captured_at: clientCapturedAt ?? null,
      server_received_at: serverReceivedAt
    })
    .select("id")
    .single();
  if (sampleInsert.error) throw new Error(sampleInsert.error.message);

  if (geofence.status === "outside") {
    const distanceM = geofence.distanceM;
    const radiusM = geofence.radiusM;
    const stationLabel = geofence.station?.stationCode || geofence.station?.stationName || "station";
    const distanceLabel = distanceM != null ? `${Math.round(distanceM)}m` : "unknown distance";
    const allowedLabel = radiusM != null ? `${Math.round(radiusM)}m` : `${FALLBACK_GEOFENCE_RADIUS_M}m`;

    await supabaseAdmin
      .from("attendance_punches")
      .update({ is_flagged: true, geofence_status: "outside", distance_m: distanceM })
      .eq("id", punchId);
    await holdAttendancePunch(punchId);

    const flag = await openIntegrityFlag({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      profileType: worker.profileType,
      profileId: worker.profileId,
      punchId,
      locationId: preferredLocationId,
      punchDate,
      flagType: "outside_geofence_punch",
      severity: "high",
      message: `Biometric punch outside ${stationLabel} — phone ${distanceLabel} away (allowed ${allowedLabel}).`,
      details: {
        reason: "phone_outside_on_biometric_punch",
        sampleId: sampleInsert.data.id,
        sampleAt: serverReceivedAt,
        distanceM,
        radiusM,
        lat,
        lng,
        punchId,
        pendingAttendance: true
      }
    });

    if (flag.id) {
      await notifyLocationFlagged({
        accountId: worker.profileId,
        companyId: worker.companyId,
        profileType: worker.profileType,
        punchDate,
        punchId,
        flagId: flag.id,
        sourceKey: `biometric-punch-outside:${punchId}`
      });
    }

    await rebuildAttendanceDay(worker.companyId, worker.enrolmentId, punchDate);
    return { ok: true as const, flagged: true as const, flagId: flag.id, geofence, sampleId: String(sampleInsert.data.id) };
  }

  await supabaseAdmin
    .from("attendance_punches")
    .update({
      calculated: true,
      is_flagged: false,
      geofence_status: geofence.status === "inside" ? "inside" : "unknown",
      distance_m: geofence.distanceM
    })
    .eq("id", punchId);

  await rebuildAttendanceDay(worker.companyId, worker.enrolmentId, punchDate);
  return { ok: true as const, flagged: false as const, geofence, sampleId: String(sampleInsert.data.id) };
}

export async function finalizeBiometricPunchLocationIfMissing({
  worker,
  punchId
}: {
  worker: ConnectAttendanceWorker;
  punchId: string;
}) {
  if (!supabaseAdmin) return null;

  const integrityEnabled = await resolveStationIntegrityFlagsEnabled(worker.locationId);
  if (!integrityEnabled) return null;

  const punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_time, punch_date, source")
    .eq("id", punchId)
    .eq("company_id", worker.companyId)
    .eq("enrolment_id", worker.enrolmentId)
    .maybeSingle();
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data || String(punch.data.source ?? "biometric") !== "biometric") return null;

  const punchTimeMs = new Date(String(punch.data.punch_time)).getTime();
  const ageMs = Date.now() - punchTimeMs;
  if (!Number.isFinite(punchTimeMs) || ageMs < BIOMETRIC_PUNCH_CORRELATION_WINDOW_MS) {
    return { deferred: true as const };
  }
  if (ageMs > BIOMETRIC_PUNCH_CORRELATION_WINDOW_MS + 10 * 60 * 1000) return null;

  const correlated = await loadPunchCorrelatedSample({
    companyId: worker.companyId,
    enrolmentId: worker.enrolmentId,
    punchId
  });
  if (correlated) return null;

  const punchDate = String(punch.data.punch_date);
  const openFlag = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id")
    .eq("company_id", worker.companyId)
    .eq("enrolment_id", worker.enrolmentId)
    .eq("punch_id", punchId)
    .in("flag_type", ["outside_geofence_punch", "biometric_phone_mismatch"])
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (openFlag.data?.id) return null;

  await holdAttendancePunch(punchId);
  const flag = await openIntegrityFlag({
    companyId: worker.companyId,
    enrolmentId: worker.enrolmentId,
    profileType: worker.profileType,
    profileId: worker.profileId,
    punchId,
    locationId: worker.locationId,
    punchDate,
    flagType: "biometric_phone_mismatch",
    severity: "high",
    message:
      "Biometric punch with no punch-time phone GPS — possible buddy punch (phone did not report location at punch).",
    details: {
      reason: "phone_location_missing",
      windowMs: BIOMETRIC_PUNCH_CORRELATION_WINDOW_MS,
      punchId,
      pendingAttendance: true
    }
  });

  if (flag.id) {
    await notifyLocationFlagged({
      accountId: worker.profileId,
      companyId: worker.companyId,
      profileType: worker.profileType,
      punchDate,
      punchId,
      flagId: flag.id,
      sourceKey: `biometric-mismatch:${punchId}`
    });
  }

  await rebuildAttendanceDay(worker.companyId, worker.enrolmentId, punchDate);
  return flag;
}
