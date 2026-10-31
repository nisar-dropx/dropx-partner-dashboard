import "server-only";

import { supabaseAdmin } from "./supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export type ConnectApprovalLocation = {
  stationCode: string;
  stationName: string;
};

function locationLabel(station: { station_code?: string | null; station_name?: string | null } | null | undefined): ConnectApprovalLocation {
  const stationCode = String(station?.station_code ?? "").trim();
  const stationName = String(station?.station_name ?? "").trim();
  return { stationCode, stationName };
}

export function approvalLocationLabel(location?: ConnectApprovalLocation | null) {
  if (!location) return "";
  return location.stationName || location.stationCode || "";
}

export function withApprovalLocationName(name: string, location?: ConnectApprovalLocation | null) {
  const place = approvalLocationLabel(location);
  if (!place) return name;
  return `${name} · ${place}`;
}

/** Station labels keyed as `employee:id` / `contractor:id` / `workforce:id`. */
export async function loadConnectApprovalLocations(
  companyId: string,
  people: Array<{ profileType: string; profileId: string | null | undefined }>
) {
  const employeeIds = [...new Set(people.filter((row) => row.profileType === "employee" && row.profileId).map((row) => String(row.profileId)))];
  const contractorIds = [...new Set(people.filter((row) => row.profileType === "contractor" && row.profileId).map((row) => String(row.profileId)))];
  const workforceIds = [...new Set(people.filter((row) => row.profileType === "workforce" && row.profileId).map((row) => String(row.profileId)))];
  const locations = new Map<string, ConnectApprovalLocation>();
  if (!employeeIds.length && !contractorIds.length && !workforceIds.length) return locations;

  const [employees, contractors, workforce] = await Promise.all([
    employeeIds.length
      ? db().from("employees").select("id,stations(station_code,station_name)").eq("company_id", companyId).in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
    contractorIds.length
      ? db().from("contractors").select("id,stations(station_code,station_name)").eq("company_id", companyId).in("id", contractorIds)
      : Promise.resolve({ data: [], error: null }),
    workforceIds.length
      ? db().from("workforce").select("id,location_id").eq("company_id", companyId).in("id", workforceIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (employees.error) throw new Error(employees.error.message);
  if (contractors.error) throw new Error(contractors.error.message);
  if (workforce.error) throw new Error(workforce.error.message);

  for (const row of employees.data ?? []) {
    locations.set(`employee:${row.id}`, locationLabel(relation(row.stations)));
  }
  for (const row of contractors.data ?? []) {
    locations.set(`contractor:${row.id}`, locationLabel(relation(row.stations)));
  }

  const stationIds = [...new Set((workforce.data ?? []).map((row) => row.location_id).filter(Boolean).map(String))];
  const stations = stationIds.length
    ? await db().from("stations").select("id,station_code,station_name").eq("company_id", companyId).in("id", stationIds)
    : { data: [], error: null };
  if (stations.error) throw new Error(stations.error.message);
  const stationById = new Map((stations.data ?? []).map((row) => [row.id, locationLabel(row)]));
  for (const row of workforce.data ?? []) {
    locations.set(`workforce:${row.id}`, stationById.get(row.location_id) ?? { stationCode: "", stationName: "" });
  }
  return locations;
}

export function connectApprovalLocationFromJoin(
  stations: { station_code?: string | null; station_name?: string | null } | { station_code?: string | null; station_name?: string | null }[] | null | undefined
): ConnectApprovalLocation {
  return locationLabel(relation(stations));
}
