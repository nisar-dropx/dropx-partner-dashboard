import "server-only";

import { istDate, punchLabel, rebuildAttendanceDay, resolveAttendanceWorkDate } from "@/lib/biometric/attendance";
import { createAppNotification } from "@/lib/app-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const APP_GPS_DEVICE_SERIAL = "APP_GPS";
/** Only used when a station has no radius configured yet (admin should set per station). */
export const FALLBACK_GEOFENCE_RADIUS_M = 50;
export const ACCURACY_FLAG_THRESHOLD_M = 100;
/** Continuous outside-zone before manager flag (phone must stay beyond station radius). */
export const OUTSIDE_CONTINUOUS_MS = 30 * 60 * 1000;
/** After punch-in, collect phone GPS only for this window (then stop). */
export const LOCATION_TRACKING_MS = 9 * 60 * 60 * 1000;
export const SHIFT_REMINDER_MS = [9.5 * 60 * 60 * 1000, 10 * 60 * 60 * 1000] as const;
/** Biometric punch must match a phone GPS sample within this lookback. */
export const BIOMETRIC_SAMPLE_WINDOW_MS = 20 * 60 * 1000;
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
    | "forgot_punch_out"
    | "pending_selfie_punch";
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

/** Hold a punch out of attendance_daily until a manager approves the related flag/package. */
export async function holdAttendancePunch(punchId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, company_id, enrolment_id, punch_date, calculated")
    .eq("id", punchId)
    .maybeSingle();
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data) return false;

  const update = await supabaseAdmin
    .from("attendance_punches")
    .update({ calculated: false, is_flagged: true })
    .eq("id", punchId);
  if (update.error) throw new Error(update.error.message);

  await rebuildAttendanceDay(
    String(punch.data.company_id),
    String(punch.data.enrolment_id),
    String(punch.data.punch_date)
  );
  return true;
}

/** After manager approve: count the held punch toward attendance calendar/daily. */
export async function activateHeldAttendancePunch(punchId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const punch = await supabaseAdmin
    .from("attendance_punches")
    .select("id, company_id, enrolment_id, punch_date, calculated")
    .eq("id", punchId)
    .maybeSingle();
  if (punch.error) throw new Error(punch.error.message);
  if (!punch.data) return false;
  if (punch.data.calculated === true) return false;

  const update = await supabaseAdmin
    .from("attendance_punches")
    .update({ calculated: true, is_flagged: false })
    .eq("id", punchId);
  if (update.error) throw new Error(update.error.message);

  await rebuildAttendanceDay(
    String(punch.data.company_id),
    String(punch.data.enrolment_id),
    String(punch.data.punch_date)
  );
  return true;
}

export async function resolveIntegrityFlag(flagId: string, resolvedBy: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, punch_id")
    .eq("id", flagId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

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

  if (existing.data?.punch_id) {
    await activateHeldAttendancePunch(String(existing.data.punch_id));
  }
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
  const previousDateValue = new Date(`${date}T00:00:00Z`);
  previousDateValue.setUTCDate(previousDateValue.getUTCDate() - 1);
  const previousDate = previousDateValue.toISOString().slice(0, 10);
  const dates = punchDate ? [date] : [date, previousDate];

  // Duty status includes calculated punches and held flagged punches awaiting
  // manager approval. The calendar remains based on calculated punches only.
  const dutyResult = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_time, punch_date, calculated, is_flagged, location_id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .in("punch_date", dates)
    .or("calculated.eq.true,is_flagged.eq.true")
    .order("punch_time", { ascending: true });
  if (dutyResult.error && !/does not exist|schema cache|is_flagged/i.test(dutyResult.error.message)) {
    throw new Error(dutyResult.error.message);
  }

  const dutyByDate = new Map<string, typeof dutyResult.data>();
  for (const row of dutyResult.data ?? []) {
    const rowDate = String(row.punch_date ?? date);
    const rows = dutyByDate.get(rowDate) ?? [];
    rows.push(row);
    dutyByDate.set(rowDate, rows);
  }

  let selectedDate = date;
  let dutyPunches = dutyByDate.get(date) ?? [];
  if (!dutyPunches.length && !punchDate) {
    const priorPunches = dutyByDate.get(previousDate) ?? [];
    if (priorPunches.length % 2 === 1 && priorPunches[0]?.punch_time) {
      const settings = await supabaseAdmin
        .from("hr_company_settings")
        .select("overnight_shift_pairing_enabled, maximum_daily_minutes")
        .eq("company_id", companyId)
        .maybeSingle();
      if (settings.error) throw new Error(settings.error.message);
      const elapsedMinutes =
        (Date.now() - new Date(String(priorPunches[0].punch_time)).getTime()) / 60_000;
      const maximumDailyMinutes = Math.max(1, Number(settings.data?.maximum_daily_minutes ?? 960));
      if (
        settings.data?.overnight_shift_pairing_enabled !== false &&
        elapsedMinutes > 0 &&
        elapsedMinutes <= maximumDailyMinutes
      ) {
        selectedDate = previousDate;
        dutyPunches = priorPunches;
      }
    }
  }

  if (dutyPunches.length || dutyResult.error) {
    const pendingApproval = dutyPunches.some((row) => row.calculated === false);
    const inTime = dutyPunches[0]?.punch_time
      ? new Date(String(dutyPunches[0].punch_time))
      : null;
    const open = dutyPunches.length % 2 === 1;
    const outTime =
      !open && dutyPunches.length > 1
        ? new Date(String(dutyPunches[dutyPunches.length - 1].punch_time))
        : null;
    const locationId =
      (dutyPunches[dutyPunches.length - 1]?.location_id as string | null | undefined) ?? null;
    return {
      punchDate: selectedDate,
      inTime,
      outTime,
      open,
      punchCount: dutyPunches.length,
      locationId,
      pendingApproval,
      dutyOnly: pendingApproval
    };
  }

  const daily = await supabaseAdmin
    .from("attendance_daily")
    .select("punch_date, in_time, out_time, punch_count, status, location_id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .in("punch_date", dates)
    .order("punch_date", { ascending: false });
  if (daily.error) throw new Error(daily.error.message);
  const openRows = (daily.data ?? []).filter((row) => row.in_time && Number(row.punch_count ?? 0) % 2 === 1);
  let selected = openRows.find((row) => row.punch_date === date) ?? null;

  if (!selected && !punchDate) {
    const prior = openRows.find((row) => row.punch_date === previousDate) ?? null;
    if (prior?.in_time) {
      const settings = await supabaseAdmin
        .from("hr_company_settings")
        .select("overnight_shift_pairing_enabled, maximum_daily_minutes")
        .eq("company_id", companyId)
        .maybeSingle();
      if (settings.error) throw new Error(settings.error.message);
      const elapsedMinutes = (Date.now() - new Date(prior.in_time).getTime()) / 60_000;
      const maximumDailyMinutes = Math.max(1, Number(settings.data?.maximum_daily_minutes ?? 960));
      if (settings.data?.overnight_shift_pairing_enabled !== false && elapsedMinutes > 0 && elapsedMinutes <= maximumDailyMinutes) {
        selected = prior;
      }
    }
  }

  const inTime = selected?.in_time ? new Date(selected.in_time) : null;
  const outTime = selected?.out_time ? new Date(selected.out_time) : null;
  const punchCount = Number(selected?.punch_count ?? 0);
  const open = Boolean(inTime && punchCount % 2 === 1);
  return {
    punchDate: String(selected?.punch_date ?? date),
    inTime,
    outTime,
    open,
    punchCount,
    locationId: (selected?.location_id as string | null) ?? null,
    pendingApproval: false,
    dutyOnly: false
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
  // Count all punches for ordering (held + calculated). Held selfie punches do not
  // write attendance_daily until a manager approves the support package.
  const punchDate = await resolveAttendanceWorkDate({
    accountId: profileId,
    companyId,
    employeeId,
    enrolmentId,
    fieldExecutiveId,
    profileType,
    punchTime: serverReceivedAt
  });
  const existing = await supabaseAdmin
    .from("attendance_punches")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate);
  if (existing.error) throw new Error(existing.error.message);
  const nextOrder = (existing.data?.length ?? 0) + 1;

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
      // Held until People/manager approve — never Present on calendar before that.
      calculated: false,
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
      is_flagged: true
    })
    .select("id, punch_time, punch_date, punch_order, punch_label, is_flagged, geofence_status, distance_m, integrity_score, calculated")
    .single();
  if (insert.error) throw new Error(insert.error.message);

  const flagIds: string[] = [];
  const pendingFlag = await openIntegrityFlag({
    companyId,
    enrolmentId,
    profileType,
    profileId,
    punchId: insert.data.id as string,
    locationId,
    punchDate,
    flagType: "pending_selfie_punch",
    severity: integrity.isRisk ? "high" : "medium",
    message: integrity.isRisk
      ? `Selfie punch pending manager approval (integrity risk: ${integrity.reasons.join(", ")}).`
      : "Selfie punch pending manager approval — attendance will update only after approve.",
    details: {
      reasons: integrity.reasons,
      signals: integritySignals,
      score: integrity.score,
      lat,
      lng,
      distanceM: geofence.distanceM,
      radiusM: geofence.radiusM,
      pendingAttendance: true
    }
  });
  flagIds.push(pendingFlag.id);

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
    isFlagged: true,
    flagIds,
    supportRequired: true,
    pendingApproval: true
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

  // Connect-linked workers must have a recent phone GPS sample at biometric punch time.
  // No sample → likely buddy punch / phone left elsewhere without reporting.
  if (!sample.data) {
    if (!accountId && !profileId) return null;
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
      message:
        "Biometric punch with no recent phone GPS — possible buddy punch (phone was not reporting location).",
      details: {
        reason: "phone_location_missing",
        windowMs: BIOMETRIC_SAMPLE_WINDOW_MS,
        punchId,
        pendingAttendance: true
      }
    });
    // Hold punch off calendar until manager approves support package.
    await holdAttendancePunch(punchId).catch((error) => {
      console.error("Unable to hold biometric punch for mismatch:", error);
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

  const lat = toNumber(sample.data.lat);
  const lng = toNumber(sample.data.lng);
  let outside = Boolean(sample.data.outside_zone);
  let distanceM = toNumber(sample.data.distance_m);
  let radiusM: number | null = null;
  let stationCode: string | null = null;
  let stationName: string | null = null;
  let geofenceStatus: GeofenceStatus = outside ? "outside" : "inside";

  if (lat != null && lng != null) {
    const geofence = await resolveCompanyPunchGeofence({
      companyId,
      lat,
      lng,
      preferredLocationId: locationId
    });
    geofenceStatus = geofence.status;
    distanceM = geofence.distanceM;
    radiusM = geofence.radiusM;
    stationCode = geofence.station?.stationCode ?? null;
    stationName = geofence.station?.stationName ?? null;
    // Fraud = phone clearly outside every company station zone.
    outside = geofence.status === "outside";
  }

  if (!outside) return null;

  const punchUpdate = await supabaseAdmin
    .from("attendance_punches")
    .update({ is_flagged: true, geofence_status: "outside", distance_m: distanceM })
    .eq("id", punchId);
  if (punchUpdate.error && !/does not exist|schema cache|is_flagged|geofence_status/i.test(punchUpdate.error.message)) {
    console.error("Unable to mark biometric punch flagged:", punchUpdate.error.message);
  }

  const distanceLabel = distanceM != null ? `${Math.round(distanceM)}m` : "unknown distance";
  const allowedLabel = radiusM != null ? `${Math.round(radiusM)}m` : `${FALLBACK_GEOFENCE_RADIUS_M}m`;
  const stationLabel = stationCode || stationName || "station";

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
    message: `Biometric punch while phone was outside ${stationLabel} · device ${distanceLabel} away (allowed ${allowedLabel}).`,
    details: {
      reason: "phone_outside_on_biometric_punch",
      sampleId: sample.data.id,
      sampleAt: sample.data.server_received_at,
      distanceM,
      radiusM,
      lat,
      lng,
      geofenceStatus,
      stationCode,
      stationName,
      punchId,
      pendingAttendance: true
    }
  });

  // First flagged punch stays off calendar until manager resolves/approves.
  await holdAttendancePunch(punchId).catch((error) => {
    console.error("Unable to hold biometric punch for mismatch:", error);
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
