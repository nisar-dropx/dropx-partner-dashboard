type Relation<T> = T | T[] | null;
export type WorkforceProfileStatusSource = {
  onboarding_status?: string | null;
  lifecycle_status?: string | null;
  people_lifecycle_status?: string | null;
  is_active?: boolean | null;
  deleted_at?: unknown;
};
export type WorkforceStation = {
  id: string;
  station_code?: string;
  parent_station_id?: string | null;
  hide_from_location_list?: boolean | null;
  is_active?: boolean;
  providers?: Relation<{ name: string }>;
  location_models?: Relation<{ code: string; name?: string }>;
};
function first<T>(value: Relation<T> | undefined) { return Array.isArray(value) ? value[0] : value; }
function normalized(value: string | undefined) { return (value ?? "").trim().toUpperCase().replace(/[ _-]/g, ""); }
function humanizedStatus(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function workforceProfileStatus(source?: WorkforceProfileStatusSource | null) {
  if (!source) return "";
  if (source.deleted_at) return "Inactive";
  const lifecycle = String(source.people_lifecycle_status ?? source.lifecycle_status ?? "").trim().toLowerCase();
  if (lifecycle && lifecycle !== "active" && lifecycle !== "onboarding") return humanizedStatus(lifecycle);
  const onboarding = String(source.onboarding_status ?? "").trim().toLowerCase();
  if (onboarding && onboarding !== "active") return humanizedStatus(onboarding);
  return source.is_active === true ? "Active" : "Inactive";
}

export function workforceStationPolicy(station: WorkforceStation) {
  const provider = normalized(first(station.providers)?.name);
  const model = normalized(first(station.location_models)?.code || first(station.location_models)?.name);
  return {
    excluded: (provider === "AMAZON" && ["NOW", "AMAZONNOW"].includes(model)) || ["HO", "DROPXHO", "HEADOFFICE"].includes(model),
    requiresStationEmail: provider === "AMAZON" && ["EDSP", "XPT", "AMXL"].includes(model),
  };
}
export function workforceStationEmailError(email: string, stationCode: string, required: boolean) {
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "enter a valid email address.";
  if (!required) return null;
  // Digits after the station code are allowed: the plain mailbox name is often already taken.
  const local = value.split("@")[0].toLowerCase().replace(/\d+$/, "");
  const suffix = `.${stationCode.trim().toLowerCase()}`;
  if (local.length > suffix.length && local.endsWith(suffix)) return null;
  return `use an email ending in .${stationCode.toLowerCase()} before @, for example akshay.${stationCode.toLowerCase()}@outlook.com. numbers after .${stationCode.toLowerCase()} and any email domain are allowed.`;
}
export function workforceRegisterLocations<T extends WorkforceStation>(stations: T[], auth: { hasAllLocationAccess: boolean; locationScopeIds: string[] }) {
  const ids = new Set(auth.hasAllLocationAccess ? stations.map(s => s.id) : auth.locationScopeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of stations) if (s.parent_station_id && ids.has(s.parent_station_id) && !ids.has(s.id)) { ids.add(s.id); changed = true; }
  }
  return stations.filter(s => ids.has(s.id) && !workforceStationPolicy(s).excluded);
}
