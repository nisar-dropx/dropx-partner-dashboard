import "server-only";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { nlPeopleClusters } from "./nl-loss-clusters";

export type AuditClusters = {
  byStation: Record<string, string[]>;
  options: { value: string; label: string }[];
};

/** stations.cluster_name holds stale free text; current People ownership names the cluster. */
export async function loadAuditClusters(
  companyId: string,
  stations: { id: string }[],
): Promise<AuditClusters> {
  const hierarchy = await loadPeopleOperationalHierarchy(
    companyId,
    stations.map((station) => station.id),
    { includeStationResponsibilities: true },
  );
  if (hierarchy.error)
    console.error("[station-audits] unable to resolve People clusters", {
      companyId,
      error: hierarchy.error,
    });
  const clusters = nlPeopleClusters(stations, hierarchy.byLocation);
  return {
    byStation: Object.fromEntries(
      [...clusters.byStation].map(([id, row]) => [id, row.clusterKeys]),
    ),
    options: clusters.options,
  };
}
