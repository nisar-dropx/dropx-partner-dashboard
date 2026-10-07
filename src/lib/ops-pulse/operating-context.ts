import { cookies } from "next/headers";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { locationModelName, providerName } from "@/lib/ops-pulse/cod";

export const operatingModes = [
  { code: "amazon_edsp", label: "Amazon EDSP" },
  { code: "flipkart_odh_mdh", label: "Flipkart ODH/MDH" },
  { code: "amazon_now", label: "Dark Store (DS)" }
] as const;

export type OperatingMode = typeof operatingModes[number]["code"];

export function operatingModeForLocation(location: CodLocationRow): OperatingMode | null {
  const model = locationModelName(location).toUpperCase();
  const provider = providerName(location).toUpperCase();
  if (model === "NOW" || `${provider} ${model}`.includes("AMAZON NOW")) return "amazon_now";
  if (model === "ODH" || model === "MDH") return "flipkart_odh_mdh";
  if (["EDSP", "XPT", "AMXL"].includes(model) && provider.includes("AMAZON")) return "amazon_edsp";
  return null;
}

export function isAmazonEdspXptLocation(location: CodLocationRow) {
  const model = locationModelName(location).toUpperCase();
  const provider = providerName(location).toUpperCase();
  const code = String(location.station_code ?? "").trim().toUpperCase();
  const name = String(location.station_name ?? "").trim().toUpperCase();
  const nonOperational = /^(TEST|DEMO)(?:_|$)/.test(code) || /^(TEST|DEMO)(?:\s|$)/.test(name);
  return !nonOperational && provider.includes("AMAZON") && (model === "EDSP" || model === "XPT");
}

export function locationsForMode(locations: CodLocationRow[], mode: OperatingMode) {
  return locations.filter((location) => operatingModeForLocation(location) === mode);
}

export function resolveOperatingContext(locations: CodLocationRow[]) {
  locations = locations.filter(l=>!l.is_ho&&!l.hide_from_location_list);
  const availableModes = operatingModes.filter((mode) => locationsForMode(locations, mode.code).length);
  const requestedMode = cookies().get("dropx-ops-mode")?.value as OperatingMode | undefined;
  const mode = availableModes.some((entry) => entry.code === requestedMode)
    ? requestedMode!
    : availableModes[0]?.code ?? "amazon_edsp";
  const modeLocations = locationsForMode(locations, mode);
  const requestedLocationIds = (cookies().get("dropx-ops-locations")?.value ?? "")
    .split(",")
    .filter(Boolean);
  const requestedLocationId = cookies().get("dropx-ops-location")?.value;
  const selectedLocations = modeLocations.filter((entry) => requestedLocationIds.includes(entry.id));
  const scopedLocations = selectedLocations.length
    ? selectedLocations
    : [modeLocations.find((entry) => entry.id === requestedLocationId) ?? modeLocations[0]].filter(Boolean) as CodLocationRow[];
  const location = scopedLocations[0] ?? null;
  return { availableModes, location, mode, modeLocations, selectedLocations: scopedLocations };
}

export function operatingModeLabel(mode: OperatingMode) {
  return operatingModes.find((entry) => entry.code === mode)?.label ?? mode;
}
