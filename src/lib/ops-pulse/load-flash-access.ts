import "server-only";
import { unstable_cache } from "next/cache";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { loadEddStations, type EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { reviewClusterFilterOptions } from "@/lib/ops-pulse/review-policy";

export type LoadFlashCluster = { value: string; label: string; stations: string[] };

/** The signed-in viewer's own Ops Live stations. Every Ops Live API narrows to this before reading or returning anything. */
export async function loadFlashViewerStations(): Promise<EddStationOption[]> {
  const authorization = await getAuthorization();
  if (!authorization?.companyId) return [];
  return loadEddStations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess);
}

/** Requested codes that the viewer may see; all of the viewer's stations when nothing valid is requested. */
export function pickFlashStations(viewer: EddStationOption[], requested: string | null) {
  const wanted = new Set(String(requested ?? "").split(",").map((code) => code.trim().toUpperCase()).filter(Boolean));
  const picked = wanted.size ? viewer.filter((station) => wanted.has(station.code)) : [];
  return picked.length ? picked : viewer;
}

// The People hierarchy is five full-table reads; it changes with HR edits, not minute to minute.
const cachedClusterStations = unstable_cache(async (companyId: string, locationIds: string[]) => {
  const { byLocation, error } = await loadPeopleOperationalHierarchy(companyId, locationIds);
  if (error) throw new Error(error);
  const options = reviewClusterFilterOptions(byLocation);
  return options.map((option) => {
    const personId = option.value.slice(option.value.indexOf(":") + 1);
    const locations = [...byLocation].filter(([, hierarchy]) =>
      hierarchy.clusterManagers.some((manager) => manager.personId === personId) ||
      hierarchy.areaOperationsManagers.some((manager) => manager.personId === personId)).map(([locationId]) => locationId);
    return { ...option, locations };
  });
}, ["ops-live-cluster-stations-v1"], { revalidate: 600 });

/**
 * Cluster Manager / AOM options with the stations each one manages — the same
 * People operational hierarchy and option keys the Review Desk filter uses,
 * limited to the stations this viewer can already see.
 */
export async function loadFlashClusters(companyId: string, stations: EddStationOption[]): Promise<LoadFlashCluster[]> {
  if (!stations.length) return [];
  try {
    const codeByLocation = new Map(stations.map((station) => [station.locationId, station.code]));
    const options = await cachedClusterStations(companyId, [...codeByLocation.keys()].sort());
    return options
      .map((option) => ({ value: option.value, label: option.label, stations: option.locations.flatMap((id) => codeByLocation.get(id) ?? []).sort() }))
      .filter((option) => option.stations.length);
  } catch (error) {
    console.warn("[ops-live] cluster filter unavailable", error instanceof Error ? error.message : error);
    return [];
  }
}
