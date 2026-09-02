import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { loadLatestBiometricPunchNeedingLocation } from "@/lib/connect-biometric-punch-location";

const APP_GPS_DEVICE_SERIAL = "APP_GPS";
const FALLBACK_GEOFENCE_RADIUS_M = 50;
const ACCURACY_FLAG_THRESHOLD_M = 100;

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

type IntegritySignals = {
  accuracyM?: number | null;
  mockLocation?: boolean | null;
  developerMode?: boolean | null;
  vpnSuspected?: boolean | null;
  clientPlatform?: string | null;
  clientUserAgent?: string | null;
  [key: string]: unknown;
};

function toNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function istDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

function punchLabel(position: number) {
  const index = Math.max(1, Math.floor(position));
  return index % 2 === 1 ? `In${Math.ceil(index / 2)}` : `Out${index / 2}`;
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
    .eq("is_active", true)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .limit(500);
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

export function evaluateIntegrity(signals: IntegritySignals, accuracyM: number | null) {
  const reasons: string[] = [];
  let score = 100;
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
    score -= 10;
  }
  const accuracy = accuracyM ?? toNumber(signals.accuracyM);
  if (accuracy != null && accuracy > ACCURACY_FLAG_THRESHOLD_M) {
    reasons.push("poor_accuracy");
    score -= 15;
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    isRisk: reasons.length > 0
  };
}

export function parseCoordinate(value: unknown, label: string) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${label} is required.`);
  return num;
}

export function parseOptionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseClientSignals(value: unknown): IntegritySignals {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as IntegritySignals;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as IntegritySignals : {};
  } catch {
    return {};
  }
}

export function parseIntegritySignals(value: IntegritySignals): IntegritySignals {
  return {
    ...value,
    mockLocation: value.mockLocation === true || String(value.mockLocation ?? "").toLowerCase() === "true",
    developerMode: value.developerMode === true || String(value.developerMode ?? "").toLowerCase() === "true",
    vpnSuspected: value.vpnSuspected === true || String(value.vpnSuspected ?? "").toLowerCase() === "true",
    accuracyM: toNumber(value.accuracyM)
  };
}

async function resolveStationAttendanceSettings(locationId: string | null | undefined) {
  if (!supabaseAdmin || !locationId) {
    return { locationTrackingEnabled: false, integrityFlagsEnabled: false };
  }
  const result = await supabaseAdmin
    .from("stations")
    .select("attendance_location_tracking_enabled, attendance_integrity_flags_enabled")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error || !result.data) {
    return { locationTrackingEnabled: false, integrityFlagsEnabled: false };
  }
  return {
    locationTrackingEnabled: result.data.attendance_location_tracking_enabled === true,
    integrityFlagsEnabled: result.data.attendance_integrity_flags_enabled === true
  };
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

async function resolveAttendanceWorkDate({
  companyId,
  enrolmentId,
  punchTime
}: {
  companyId: string;
  enrolmentId: string;
  punchTime: Date;
}) {
  if (!supabaseAdmin) return istDate(punchTime);
  const calendarDate = istDate(punchTime);
  const previous = new Date(`${calendarDate}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDate = previous.toISOString().slice(0, 10);

  const settings = await supabaseAdmin
    .from("hr_company_settings")
    .select("overnight_shift_pairing_enabled, maximum_daily_minutes")
    .eq("company_id", companyId)
    .maybeSingle();
  if (settings.error || settings.data?.overnight_shift_pairing_enabled === false) return calendarDate;

  const currentDayPunches = await supabaseAdmin
    .from("attendance_punches")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", calendarDate)
    .limit(1);
  if (currentDayPunches.error || (currentDayPunches.data?.length ?? 0) > 0) return calendarDate;

  const previousPunches = await supabaseAdmin
    .from("attendance_punches")
    .select("punch_time")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", previousDate)
    .order("punch_time", { ascending: true });
  if (previousPunches.error) return calendarDate;
  const rows = previousPunches.data ?? [];
  if (!rows.length || rows.length % 2 === 0) return calendarDate;
  const firstIn = rows[0]?.punch_time ? new Date(String(rows[0].punch_time)) : null;
  if (!firstIn || Number.isNaN(firstIn.getTime())) return calendarDate;
  const elapsedMinutes = (punchTime.getTime() - firstIn.getTime()) / 60_000;
  const maximumDailyMinutes = Math.max(1, Number(settings.data?.maximum_daily_minutes ?? 960));
  return elapsedMinutes > 0 && elapsedMinutes <= maximumDailyMinutes ? previousDate : calendarDate;
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

  const companySettings = await supabaseAdmin
    .from("hr_company_settings")
    .select("odd_punch_treatment, overnight_shift_pairing_enabled, maximum_daily_minutes")
    .eq("company_id", companyId)
    .maybeSingle();
  if (companySettings.error) throw new Error(companySettings.error.message);
  const firstInLatestOut = companySettings.data?.odd_punch_treatment === "first_last";
  const isOpenPunchSequence = (count: number) => count === 1 || (!firstInLatestOut && count % 2 === 1);

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

  const dutyByDate = new Map<string, NonNullable<typeof dutyResult.data>>();
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
    if (isOpenPunchSequence(priorPunches.length) && priorPunches[0]?.punch_time) {
      const elapsedMinutes =
        (Date.now() - new Date(String(priorPunches[0].punch_time)).getTime()) / 60_000;
      const maximumDailyMinutes = Math.max(1, Number(companySettings.data?.maximum_daily_minutes ?? 960));
      if (
        companySettings.data?.overnight_shift_pairing_enabled !== false &&
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
    const inTime = dutyPunches[0]?.punch_time ? new Date(String(dutyPunches[0].punch_time)) : null;
    const open = isOpenPunchSequence(dutyPunches.length);
    const outTime =
      dutyPunches.length > 1 && (firstInLatestOut || !open)
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
  const openRows = (daily.data ?? []).filter((row) => row.in_time && (
    !row.out_time || (!firstInLatestOut && Number(row.punch_count ?? 0) % 2 === 1)
  ));
  let selected = openRows.find((row) => row.punch_date === date) ?? null;
  if (!selected && !punchDate) {
    const prior = openRows.find((row) => row.punch_date === previousDate) ?? null;
    if (prior?.in_time) {
      const elapsedMinutes = (Date.now() - new Date(prior.in_time).getTime()) / 60_000;
      const maximumDailyMinutes = Math.max(1, Number(companySettings.data?.maximum_daily_minutes ?? 960));
      if (
        companySettings.data?.overnight_shift_pairing_enabled !== false &&
        elapsedMinutes > 0 &&
        elapsedMinutes <= maximumDailyMinutes
      ) {
        selected = prior;
      }
    }
  }

  const inTime = selected?.in_time ? new Date(selected.in_time) : null;
  const outTime = selected?.out_time ? new Date(selected.out_time) : null;
  const punchCount = Number(selected?.punch_count ?? 0);
  const open = Boolean(inTime && (!outTime || (!firstInLatestOut && punchCount % 2 === 1)));
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

export async function loadConnectPunchStatus(worker: ConnectAttendanceWorker) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const stationSettings = await resolveStationAttendanceSettings(worker.locationId);
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

  const stations = companyStations.length ? companyStations : assignedStation ? [assignedStation] : [];
  const openFlags = flagsResult.data ?? [];
  const flagIds = openFlags.map((flag) => String(flag.id));
  const pendingByFlag = new Map<string, string>();
  if (flagIds.length) {
    const reviewsResult = await supabaseAdmin
      .from("attendance_location_reviews")
      .select("flag_id, status")
      .eq("company_id", worker.companyId)
      .eq("enrolment_id", worker.enrolmentId)
      .in("flag_id", flagIds)
      .in("status", ["pending", "returned"]);
    if (reviewsResult.error && !String(reviewsResult.error.message).toLowerCase().includes("does not exist")) {
      throw new Error(reviewsResult.error.message);
    }
    for (const row of reviewsResult.data ?? []) {
      if (row.flag_id) pendingByFlag.set(String(row.flag_id), String(row.status));
    }
  }

  const pendingForClient = openFlags.length > 0 && shift.pendingApproval === true;
  const openFlagsForClient = openFlags.map((flag) => {
    const supportStatus = pendingByFlag.get(String(flag.id));
    const reviewPending = supportStatus === "pending";
    const needsResubmit = supportStatus === "returned";
    return {
      id: flag.id,
      punch_date: flag.punch_date,
      status: flag.status,
      created_at: flag.created_at,
      flag_type: "action_needed",
      severity: "medium",
      message: reviewPending
        ? "Your selfie was submitted. Review is pending."
        : needsResubmit
          ? "Please submit a new selfie to continue."
          : "Take a live selfie at your station to continue.",
      details: {},
      supportStatus: reviewPending ? "pending_review" : needsResubmit ? "returned" : "needed",
      supportSubmitted: reviewPending
    };
  });

  const latestBiometricPunch = await loadLatestBiometricPunchNeedingLocation(worker, shift.punchDate);

  return {
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
    openFlags: openFlagsForClient,
    attendanceSettings: {
      locationTrackingEnabled: stationSettings.locationTrackingEnabled,
      integrityFlagsEnabled: stationSettings.integrityFlagsEnabled
    },
    latestBiometricPunch
  };
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
  flagType: string;
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
      .update({
        message,
        details,
        severity,
        punch_id: punchId ?? null,
        location_id: locationId ?? null,
        updated_at: now
      })
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

export async function insertConnectAppGpsPunch({
  worker,
  locationId,
  lat,
  lng,
  accuracyM,
  altitudeM,
  clientCapturedAt,
  integritySignals,
  geofence,
  integrity,
  faceMatched = false
}: {
  worker: ConnectAttendanceWorker;
  locationId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  altitudeM: number | null;
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
  const clientPunch = clientCapturedAt ? new Date(clientCapturedAt) : null;
  const clientPunchValid =
    clientPunch != null &&
    !Number.isNaN(clientPunch.getTime()) &&
    clientPunch.getTime() - serverReceivedAt.getTime() <= 5 * 60_000 &&
    serverReceivedAt.getTime() - clientPunch.getTime() <= 24 * 60 * 60_000;
  const punchAt = clientPunchValid && clientPunch ? clientPunch : serverReceivedAt;
  const punchDate = await resolveAttendanceWorkDate({
    companyId: worker.companyId,
    enrolmentId: worker.enrolmentId,
    punchTime: punchAt
  });
  const existing = await supabaseAdmin
    .from("attendance_punches")
    .select("id")
    .eq("company_id", worker.companyId)
    .eq("enrolment_id", worker.enrolmentId)
    .eq("punch_date", punchDate);
  if (existing.error) throw new Error(existing.error.message);
  const nextOrder = (existing.data?.length ?? 0) + 1;
  const stationSettings = await resolveStationAttendanceSettings(locationId);
  const holdForReview = stationSettings.integrityFlagsEnabled;
  const employeeId = worker.profileType === "employee" ? worker.profileId : null;
  const fieldExecutiveId = worker.profileType === "field_executive" || worker.profileType === "workforce"
    ? worker.profileId
    : null;

  const insert = await supabaseAdmin
    .from("attendance_punches")
    .insert({
      company_id: worker.companyId,
      raw_event_id: null,
      device_id: null,
      enrolment_id: worker.enrolmentId,
      worker_type: worker.workerType,
      profile_type: worker.profileType,
      account_id: worker.profileId,
      employee_id: employeeId,
      field_executive_id: fieldExecutiveId,
      location_id: locationId,
      device_serial: APP_GPS_DEVICE_SERIAL,
      punch_time: punchAt.toISOString(),
      punch_date: punchDate,
      punch_order: nextOrder,
      punch_label: punchLabel(nextOrder),
      worker_status: "Active",
      calculated: !holdForReview,
      source: "app_gps",
      lat,
      lng,
      accuracy_m: accuracyM,
      altitude_m: altitudeM,
      selfie_path: null,
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
      is_flagged: holdForReview
    })
    .select("id, punch_time, punch_date, punch_order, punch_label, is_flagged, geofence_status, distance_m, integrity_score, calculated")
    .single();
  if (insert.error) throw new Error(insert.error.message);

  if (!holdForReview) {
    await rebuildAttendanceDay(worker.companyId, worker.enrolmentId, punchDate).catch((error) => {
      console.error("Unable to rebuild attendance after GPS punch:", error);
    });
  }

  const flagIds: string[] = [];
  if (holdForReview) {
    const pendingFlag = await openIntegrityFlag({
      companyId: worker.companyId,
      enrolmentId: worker.enrolmentId,
      profileType: worker.profileType,
      profileId: worker.profileId,
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
    if (pendingFlag.id) flagIds.push(pendingFlag.id);
  }

  return {
    punch: insert.data,
    isFlagged: holdForReview,
    flagIds,
    supportRequired: holdForReview,
    pendingApproval: holdForReview,
    geofence
  };
}

export function mapSupabaseConfigError(message: string) {
  if (/invalid api key/i.test(message)) {
    return "DropX One database credentials are misconfigured. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Connect Vercel project.";
  }
  return message;
}
