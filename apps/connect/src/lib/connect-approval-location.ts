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

/** Station labels for employee/contractor profile ids, keyed as `employee:id` / `contractor:id`. */
export async function loadConnectApprovalLocations(
  companyId: string,
  people: Array<{ profileType: string; profileId: string | null | undefined }>
) {
  const employeeIds = [...new Set(people.filter((row) => row.profileType === "employee" && row.profileId).map((row) => String(row.profileId)))];
  const contractorIds = [...new Set(people.filter((row) => row.profileType === "contractor" && row.profileId).map((row) => String(row.profileId)))];
  const locations = new Map<string, ConnectApprovalLocation>();
  if (!employeeIds.length && !contractorIds.length) return locations;

  const [employees, contractors] = await Promise.all([
    employeeIds.length
      ? db().from("employees").select("id,stations(station_code,station_name)").eq("company_id", companyId).in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
    contractorIds.length
      ? db().from("contractors").select("id,stations(station_code,station_name)").eq("company_id", companyId).in("id", contractorIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (employees.error) throw new Error(employees.error.message);
  if (contractors.error) throw new Error(contractors.error.message);

  for (const row of employees.data ?? []) {
    locations.set(`employee:${row.id}`, locationLabel(relation(row.stations)));
  }
  for (const row of contractors.data ?? []) {
    locations.set(`contractor:${row.id}`, locationLabel(relation(row.stations)));
  }
  return locations;
}

export function connectApprovalLocationFromJoin(
  stations: { station_code?: string | null; station_name?: string | null } | { station_code?: string | null; station_name?: string | null }[] | null | undefined
): ConnectApprovalLocation {
  return locationLabel(relation(stations));
}
