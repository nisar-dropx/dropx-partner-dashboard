import type { EddPerformanceNetworkStation, EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";

export type StationEddFilter = "atStation" | "delivered" | "held" | "returned" | "all";

export const STATION_EDD_BUCKET_LABEL: Record<EddPerformancePackage["bucket"], string> = {
  yetToDispatch: "At station EDD",
  delivered: "Delivered",
  held: "On road / held",
  returned: "Returned"
};

/** Today's EDD workload includes dispatched packages plus packages still at station. */
export function stationEddTotal(row: Pick<EddPerformanceNetworkStation, "assigned" | "yetToDispatch">) {
  return row.assigned + row.yetToDispatch;
}

/** Progress uses the whole EDD workload, so at-station packages remain visible in the denominator. */
export function stationEddDeliveryProgress(
  row: Pick<EddPerformanceNetworkStation, "assigned" | "yetToDispatch" | "delivered">
) {
  const total = stationEddTotal(row);
  return total > 0 ? Math.round((row.delivered / total) * 1000) / 10 : 0;
}

export function stationEddPackageMatches(pkg: EddPerformancePackage, filter: StationEddFilter) {
  if (filter === "all") return true;
  if (filter === "atStation") return pkg.bucket === "yetToDispatch";
  return pkg.bucket === filter;
}
