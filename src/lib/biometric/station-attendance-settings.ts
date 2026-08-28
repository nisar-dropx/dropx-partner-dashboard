import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

export type StationAttendanceSettings = {
  locationId: string;
  locationTrackingEnabled: boolean;
  integrityFlagsEnabled: boolean;
};

const DEFAULTS: Omit<StationAttendanceSettings, "locationId"> = {
  locationTrackingEnabled: false,
  integrityFlagsEnabled: false
};

export type StationAttendanceSettingsRow = StationAttendanceSettings & {
  stationCode: string;
  stationName: string | null;
  city: string | null;
  state: string | null;
  isActive: boolean;
};

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function parseSettings(
  row: {
    id: string;
    attendance_location_tracking_enabled?: unknown;
    attendance_integrity_flags_enabled?: unknown;
  } | null,
  locationId: string
): StationAttendanceSettings {
  if (!row) {
    return { locationId, ...DEFAULTS };
  }
  return {
    locationId,
    locationTrackingEnabled: row.attendance_location_tracking_enabled === true,
    integrityFlagsEnabled: row.attendance_integrity_flags_enabled === true
  };
}

export async function loadStationAttendanceSettings(
  locationId: string | null | undefined
): Promise<StationAttendanceSettings | null> {
  if (!supabaseAdmin || !locationId) return null;
  const result = await supabaseAdmin
    .from("stations")
    .select("id, attendance_location_tracking_enabled, attendance_integrity_flags_enabled")
    .eq("id", locationId)
    .maybeSingle();
  if (result.error) {
    if (isMissingColumnError(result.error)) {
      return parseSettings(null, locationId);
    }
    throw new Error(result.error.message);
  }
  if (!result.data) return null;
  return parseSettings(result.data, locationId);
}

/** Defaults both toggles to OFF when location is missing or columns are not migrated yet. */
export async function resolveStationAttendanceSettings(
  locationId: string | null | undefined
): Promise<StationAttendanceSettings> {
  const loaded = await loadStationAttendanceSettings(locationId);
  if (loaded) return loaded;
  return { locationId: String(locationId ?? ""), ...DEFAULTS };
}

export async function loadCompanyStationAttendanceSettings(companyId: string) {
  if (!supabaseAdmin) {
    return { rows: [] as StationAttendanceSettingsRow[], error: "Supabase service role key is not configured.", setupPending: false };
  }

  const result = await supabaseAdmin
    .from("stations")
    .select(
      "id, station_code, station_name, city, state, is_active, attendance_location_tracking_enabled, attendance_integrity_flags_enabled"
    )
    .eq("company_id", companyId)
    .order("station_code");

  if (result.error) {
    if (isMissingColumnError(result.error)) {
      return {
        rows: [] as StationAttendanceSettingsRow[],
        error: null,
        setupPending: true
      };
    }
    return { rows: [] as StationAttendanceSettingsRow[], error: result.error.message, setupPending: false };
  }

  const rows = (result.data ?? []).map((row) => ({
    ...parseSettings(row, String(row.id)),
    stationCode: String(row.station_code ?? ""),
    stationName: (row.station_name as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    state: (row.state as string | null) ?? null,
    isActive: row.is_active !== false
  }));

  return { rows, error: null, setupPending: false };
}
