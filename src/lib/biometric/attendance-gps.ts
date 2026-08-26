import "server-only";

import { istDate, punchLabel, rebuildAttendanceDay } from "@/lib/biometric/attendance";
import { createAppNotification } from "@/lib/app-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const APP_GPS_DEVICE_SERIAL = "APP_GPS";
/** Only used when a station has no radius configured yet (admin should set per station). */
export const FALLBACK_GEOFENCE_RADIUS_M = 50;
export const ACCURACY_FLAG_THRESHOLD_M = 100;
export const OUTSIDE_CONTINUOUS_MS = 10 * 60 * 1000;
export const SHIFT_REMINDER_MS = [9.5 * 60 * 60 * 1000, 10 * 60 * 60 * 1000] as const;
export const BIOMETRIC_SAMPLE_WINDOW_MS = 15 * 60 * 1000;
export const HEARTBEAT_MIN_INTERVAL_MS = 2 * 60 * 1000;

export type GeofenceStatus = "inside" | "outside" | "unknown";

export type StationGeofence = {
  id: string;
  stationCode: string | null;
  stationName: string | null;
  latitude: number | null;
  longitude: number | null;
  /** null = not configured in Master Location; punch will be flagged as unknown zone */
  geofenceRadiusM: number | null;
};

export type IntegritySignals = {
  accuracyM?: number | null;
  mockLocation?: boolean | null;
  developerMode?: boolean | null;
  vpnSuspected?: boolean | null;
  clientPlatform?: string | null;
  clientUserAgent?: string | null;
  [key: string]: unknown;
};

export type GeofenceEvaluation = {
  status: GeofenceStatus;
  distanceM: number | null;
  radiusM: number;
  station: StationGeofence | null;
};

function toNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Haversine distance in meters between two WGS84 points. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseIntegritySignals(raw: unknown): IntegritySignals {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as IntegritySignals;
}

export function evaluateIntegrity(signals: IntegritySignals, accuracyM: number | null) {
  const reasons: string[] = [];
  let score = 100;
  if (accuracyM != null && accuracyM > ACCURACY_FLAG_THRESHOLD_M) {
    reasons.push("low_gps_accuracy");
    score -= 25;
  }
  if (signals.mockLocation === true) {
    reasons.push("mock_location");
    score -= 40;
  }
  if (signals.developerMode === true) {
    reasons.push("developer_mode");
    score -= 20;
  }
  if (signals.vpnSuspected === true) {
    reasons.push("vpn_suspected");
    score -= 20;
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    isRisk: reasons.length > 0
  };
}

export async function loadStationGeofence(locationId: string | null | undefined): Promise<StationGeofence | null> {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, latitude, longitude, geofence_radius_m")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error) {
    // Column may not exist yet before migration; fall back without radius.
    const fallback = await supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, latitude, longitude")
      .eq("id", locationId)
      .maybeSingle();
    if (fallback.error) throw new Error(fallback.error.message);
    if (!fallback.data) return null;
    return {
      id: fallback.data.id as string,
      stationCode: (fallback.data.station_code as string | null) ?? null,
      stationName: (fallback.data.station_name as string | null) ?? null,
      latitude: toNumber(fallback.data.latitude),
      longitude: toNumber(fallback.data.longitude),
      geofenceRadiusM: null
    };
  }
  if (!result.data) return null;
  return {
    id: result.data.id as string,
    stationCode: (result.data.station_code as string | null) ?? null,
    stationName: (result.data.station_name as string | null) ?? null,
    latitude: toNumber(result.data.latitude),
    longitude: toNumber(result.data.longitude),
    geofenceRadiusM: toNumber(result.data.geofence_radius_m)
  };
}

function mapStationRow(row: Record<string, unknown>): StationGeofence {
  return {
    id: row.id as string,
    stationCode: (row.station_code as string | null) ?? null,
    stationName: (row.station_name as string | null) ?? null,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    geofenceRadiusM: toNumber(row.geofence_radius_m)
  };
}

/** Active company stations with coordinates — used so staff can punch at any site, not only their assigned one. */
export async function loadCompanyStationGeofences(companyId: string): Promise<StationGeofence[]> {
  if (!supabaseAdmin) return [];
  const result = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, latitude, longitude, geofence_radius_m")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .limit(500);
  if (result.error) {
    const fallback = await supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, latitude, longitude")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .limit(500);
    if (fallback.error) throw new Error(fallback.error.message);
    return (fallback.data ?? []).map((row) => mapStationRow({ ...row, geofence_radius_m: null }));
  }
  return (result.data ?? []).map((row) => mapStationRow(row as Record<string, unknown>));
}

/**
 * Prefer assigned station if the employee is inside it; otherwise any company station whose geofence contains them.
 * Closest inside station wins when assigned is not in range (travel / temporary duty).
 */
export function resolveGeofenceAmongStations(
  lat: number,
  lng: number,
  stations: StationGeofence[],
  preferredLocationId?: string | null
): GeofenceEvaluation {
  if (!stations.length) {
    return {
      status: "unknown",
      distanceM: null,
      radiusM: FALLBACK_GEOFENCE_RADIUS_M,
      station: null
    };
  }

  const scored = stations.map((station) => ({
    station,
    evaluation: evaluateGeofence(lat, lng, station)
  }));

  const inside = scored
    .filter((row) => row.evaluation.status === "inside")
    .sort((left, right) => (left.evaluation.distanceM ?? 0) - (right.evaluation.distanceM ?? 0));

  if (inside.length) {
    const preferred = preferredLocationId
      ? inside.find((row) => row.station.id === preferredLocationId)
      : undefined;
    return (preferred ?? inside[0]).evaluation;
  }

  const nearest = scored
    .filter((row) => row.evaluation.distanceM != null)
    .sort((left, right) => (left.evaluation.distanceM ?? Number.POSITIVE_INFINITY) - (right.evaluation.distanceM ?? Number.POSITIVE_INFINITY))[0];

  if (!nearest) {
    return {
      status: "unknown",
      distanceM: null,
      radiusM: FALLBACK_GEOFENCE_RADIUS_M,
      station: null
    };
  }

  return {
    ...nearest.evaluation,
    status: nearest.evaluation.status === "unknown" ? "unknown" : "outside"
  };
}

export async function resolveCompanyPunchGeofence({
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
  return resolveGeofenceAmongStations(lat, lng, stations, preferredLocationId);
}

export function evaluateGeofence(
  lat: number,
  lng: number,
  station: StationGeofence | null
): GeofenceEvaluation {
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

export async function openIntegrityFlag({
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
  flagType:
    | "outside_geofence_punch"
    | "outside_geofence_gt_2h"
    | "biometric_phone_mismatch"
    | "integrity_risk"
    | "forgot_punch_out";
  message: string;
  details?: Record<string, unknown>;
  severity?: "low" | "medium" | "high";
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, status")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("flag_type", flagType)
    .eq("status", "open")
    .maybeSingle();
  if (existing.error && !String(existing.error.message).toLowerCase().includes("does not exist")) {
    throw new Error(existing.error.message);
  }
  if (existing.data?.id) {
    const update = await supabaseAdmin
      .from("attendance_integrity_flags")
      .update({
        message,
        details,
        severity,
        punch_id: punchId ?? null,
        location_id: locationId ?? null,
        updated_at: now
      })
      .eq("id", existing.data.id)
      .select("id, status, flag_type")
      .single();
    if (update.error) throw new Error(update.error.message);
    return { id: update.data.id as string, created: false, flagType };
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
    .select("id, status, flag_type")
    .single();
  if (insert.error) {
    if (String(insert.error.message).toLowerCase().includes("does not exist")) {
      throw new Error("Attendance GPS integrity setup is pending. Run attendance_gps_integrity_v1.sql.");
    }
    throw new Error(insert.error.message);
  }

  const flagId = insert.data.id as string;
  if (profileId) {
    const { notifyAttendanceFlagReviewers } = await import("@/lib/attendance-flag-notifications");
    await notifyAttendanceFlagReviewers({
      companyId,
      profileType,
      profileId,
      punchDate,
      flagType,
      message,
      flagId
    }).catch((error) => {
      console.error("Unable to notify attendance flag reviewers:", error);
    });
  }

  return { id: flagId, created: true, flagType };
}

export async function resolveIntegrityFlag(flagId: string, resolvedBy: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const result = await supabaseAdmin
    .from("attendance_integrity_flags")
    .update({
      status: "resolved",
      resolved_at: now,
      resolved_by: resolvedBy,
      updated_at: now
    })
    .eq("id", flagId)
    .select("id")
    .single();
  if (result.error) throw new Error(result.error.message);
}

export async function continuousOutsideMs({
  companyId,
  enrolmentId,
  sinceIso
}: {
  companyId: string;
  enrolmentId: string;
  sinceIso: string;
}) {
  if (!supabaseAdmin) return 0;
  const samples = await supabaseAdmin
    .from("attendance_location_samples")
    .select("outside_zone, server_received_at")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .gte("server_received_at", sinceIso)
    .order("server_received_at", { ascending: true });
  if (samples.error) {
    if (String(samples.error.message).toLowerCase().includes("does not exist")) return 0;
    throw new Error(samples.error.message);
  }
  const rows = samples.data ?? [];
  if (!rows.length) return 0;

  let continuousStart: number | null = null;
  let maxOutside = 0;
  let currentOutside = 0;
  for (const row of rows) {
    const at = new Date(row.server_received_at).getTime();
    if (row.outside_zone) {
      if (continuousStart == null) continuousStart = at;
      currentOutside = at - continuousStart;
      maxOutside = Math.max(maxOutside, currentOutside);
    } else {
      continuousStart = null;
      currentOutside = 0;
    }
  }
  // If still outside, extend to now.
  if (continuousStart != null) {
    maxOutside = Math.max(maxOutside, Date.now() - continuousStart);
  }
  return maxOutside;
}

export async function loadOpenShift({
  companyId,
  enrolmentId,
  punchDate
}: {
  companyId: string;
  enrolmentId: string;
  punchDate?: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const date = punchDate ?? istDate(new Date());
  const daily = await supabaseAdmin
    .from("attendance_daily")
    .select("in_time, out_time, punch_count, status, location_id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", date)
    .maybeSingle();
  if (daily.error) throw new Error(daily.error.message);
  const inTime = daily.data?.in_time ? new Date(daily.data.in_time) : null;
  const outTime = daily.data?.out_time ? new Date(daily.data.out_time) : null;
  const open = Boolean(inTime && !outTime);
  return {
    punchDate: date,
    inTime,
    outTime,
    open,
    punchCount: Number(daily.data?.punch_count ?? 0),
    locationId: (daily.data?.location_id as string | null) ?? null
  };
}

export async function maybeNotifyForgotPunchOut({
  accountId,
  companyId,
  profileType,
  enrolmentId,
  punchDate,
  inTime
}: {
  accountId: string;
  companyId: string;
  profileType: string;
  enrolmentId: string;
  punchDate: string;
  inTime: Date;
}) {
  const elapsed = Date.now() - inTime.getTime();
  for (const threshold of SHIFT_REMINDER_MS) {
    if (elapsed < threshold) continue;
    const hoursLabel = String(threshold / (60 * 60 * 1000));
    const flag = await openIntegrityFlag({
      companyId,
      enrolmentId,
      profileType,
      profileId: accountId,
      punchDate,
      flagType: "forgot_punch_out",
      severity: threshold >= 10 * 60 * 60 * 1000 ? "high" : "medium",
      message: `No punch-out after ${hoursLabel} hours from punch-in.`,
      details: { thresholdMs: threshold, inTime: inTime.toISOString() }
    });
    if (flag.created) {
      await createAppNotification({
        accountId,
        companyId,
        data: { punchDate, enrolmentId, hours: hoursLabel },
        eventCode: "attendance_forgot_punch_out",
        profileType,
        sourceKey: `forgot-punch-out:${enrolmentId}:${punchDate}:${hoursLabel}`,
        variables: { date: punchDate.split("-").reverse().join("/"), hours: hoursLabel }
      }).catch(() => undefined);
    }
  }
}

export async function insertAppGpsPunch({
  companyId,
  enrolmentId,
  workerType,
  profileType,
  profileId,
  employeeId,
  fieldExecutiveId,
  locationId,
  lat,
  lng,
  accuracyM,
  altitudeM,
  selfiePath = null,
  clientCapturedAt,
  integritySignals,
  geofence,
  integrity,
  faceMatched = false
}: {
  companyId: string;
  enrolmentId: string;
  workerType: string;
  profileType: string;
  profileId: string;
  employeeId: string | null;
  fieldExecutiveId: string | null;
  locationId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  altitudeM: number | null;
  selfiePath?: string | null;
  clientCapturedAt: string | null;
  integritySignals: IntegritySignals;
  geofence: GeofenceEvaluation;
  integrity: ReturnType<typeof evaluateIntegrity>;
  faceMatched?: boolean;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (geofence.status !== "inside") {
    throw new Error(
      geofence.status === "unknown"
        ? "Station geofence is not configured. Contact admin before punching."
        : `You are outside the allocated station zone (${geofence.distanceM}m away, allowed ${geofence.radiusM}m). Move inside to punch.`
    );
  }
  if (!faceMatched) {
    throw new Error("Selfie must match your profile photo before punching.");
  }

  const serverReceivedAt = new Date();
  const punchDate = istDate(serverReceivedAt);
  const existing = await supabaseAdmin
    .from("attendance_punches")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("calculated", true);
  if (existing.error) throw new Error(existing.error.message);
  const nextOrder = (existing.data?.length ?? 0) + 1;
  const isFlagged = integrity.isRisk;

  const insert = await supabaseAdmin
    .from("attendance_punches")
    .insert({
      company_id: companyId,
      raw_event_id: null,
      device_id: null,
      enrolment_id: enrolmentId,
      worker_type: workerType,
      profile_type: profileType,
      account_id: profileId,
      employee_id: employeeId,
      field_executive_id: fieldExecutiveId,
      location_id: locationId,
      device_serial: APP_GPS_DEVICE_SERIAL,
      punch_time: serverReceivedAt.toISOString(),
      punch_date: punchDate,
      punch_order: nextOrder,
      punch_label: punchLabel(nextOrder),
      worker_status: "Active",
      calculated: true,
      source: "app_gps",
      lat,
      lng,
      accuracy_m: accuracyM,
      altitude_m: altitudeM,
      selfie_path: selfiePath,
      client_captured_at: clientCapturedAt,
      server_received_at: serverReceivedAt.toISOString(),
      integrity_score: integrity.score,
      integrity_signals: {
        ...integritySignals,
        reasons: integrity.reasons,
        faceMatched: true
      },
      geofence_status: geofence.status,
      distance_m: geofence.distanceM,
      is_flagged: isFlagged
    })
    .select("id, punch_time, punch_date, punch_order, punch_label, is_flagged, geofence_status, distance_m, integrity_score")
    .single();
  if (insert.error) throw new Error(insert.error.message);

  await rebuildAttendanceDay(companyId, enrolmentId, punchDate);

  const flagIds: string[] = [];
  if (integrity.isRisk) {
    const flag = await openIntegrityFlag({
      companyId,
      enrolmentId,
      profileType,
      profileId,
      punchId: insert.data.id as string,
      locationId,
      punchDate,
      flagType: "integrity_risk",
      severity: "high",
      message: `Integrity risk on app punch: ${integrity.reasons.join(", ")}.`,
      details: { reasons: integrity.reasons, signals: integritySignals, score: integrity.score }
    });
    flagIds.push(flag.id);
  }

  return {
    punch: insert.data,
    isFlagged,
    flagIds,
    supportRequired: isFlagged
  };
}

export async function checkBiometricPhoneMismatch({
  companyId,
  enrolmentId,
  punchId,
  punchDate,
  locationId,
  profileType,
  profileId,
  accountId
}: {
  companyId: string;
  enrolmentId: string;
  punchId: string;
  punchDate: string;
  locationId: string | null;
  profileType: string | null;
  profileId: string | null;
  accountId: string | null;
}) {
  if (!supabaseAdmin) return null;
  const since = new Date(Date.now() - BIOMETRIC_SAMPLE_WINDOW_MS).toISOString();
  const sample = await supabaseAdmin
    .from("attendance_location_samples")
    .select("id, lat, lng, outside_zone, distance_m, server_received_at")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .gte("server_received_at", since)
    .order("server_received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sample.error) {
    if (String(sample.error.message).toLowerCase().includes("does not exist")) return null;
    throw new Error(sample.error.message);
  }
  if (!sample.data?.outside_zone) return null;

  // Mark biometric punch flagged when possible.
  const punchUpdate = await supabaseAdmin
    .from("attendance_punches")
    .update({ is_flagged: true, geofence_status: "outside", distance_m: sample.data.distance_m })
    .eq("id", punchId);
  if (punchUpdate.error && !/does not exist|schema cache|is_flagged|geofence_status/i.test(punchUpdate.error.message)) {
    console.error("Unable to mark biometric punch flagged:", punchUpdate.error.message);
  }

  const flag = await openIntegrityFlag({
    companyId,
    enrolmentId,
    profileType,
    profileId: profileId ?? accountId,
    punchId,
    locationId,
    punchDate,
    flagType: "biometric_phone_mismatch",
    severity: "high",
    message: "Biometric punch recorded while phone GPS was outside the station geofence.",
    details: {
      sampleId: sample.data.id,
      distanceM: sample.data.distance_m,
      sampleAt: sample.data.server_received_at
    }
  });

  if (flag.created && (accountId || profileId)) {
    await createAppNotification({
      accountId: (accountId ?? profileId) as string,
      companyId,
      data: { punchDate, punchId, flagId: flag.id },
      eventCode: "attendance_location_flagged",
      profileType: profileType ?? "employee",
      sourceKey: `biometric-mismatch:${punchId}`,
      variables: { date: punchDate.split("-").reverse().join("/") }
    }).catch(() => undefined);
  }

  return flag;
}
