import type { EddPackage } from "./edd-worker";
import { eddAttemptLifecycle, eddCurrentState, eddDeliveredState } from "./edd-verification";
import { isForwardEdd, stationEddDate, stationEddPosition } from "./station-edd";

export const EDD_MOVEMENT_GROUPS = [
  ["atStation", "At station"], ["onRoad", "On road"], ["delivered", "Delivered"],
  ["exceptions", "Attempted / rejected / held"], ["transit", "Inbound / returns"]
] as const;
export type EddMovementGroup = typeof EDD_MOVEMENT_GROUPS[number][0];
// Compact, immutable checkpoint evidence. No customer addresses or cash data.
export type EddCheckpointPackage = [tid: string, status: string, group: EddMovementGroup | "unmapped", driver: string, sourceAt: string, lifecycle: string, freshPending: boolean];
export type EddMovement = Record<EddMovementGroup, number> & {
  total: number; unmapped: number; pending: number; stationReturns: number;
  statuses: Array<{ status: string; count: number }>;
};
export function eddMovementGroup(pkg: EddPackage): EddMovementGroup | "unmapped" {
  const state = eddCurrentState(pkg);
  if (eddDeliveredState(state)) return "delivered";
  if (["INDUCTED", "RECEIVED"].includes(state)) return "atStation";
  if (["IN_TRANSIT_TO_CUSTOMER", "OUT_FOR_DELIVERY"].includes(state)
    || state === "IN_TRANSIT" && pkg.verification?.firstDispatchAt) return "onRoad";
  if (["DELIVERY_ATTEMPTED", "DELIVERY_FAILED", "DELIVERY_REJECTED", "REJECTED", "HELD", "DELAYED", "UNDELIVERABLE", "MARKED_FOR_PROBLEM"].includes(state)) return "exceptions";
  if (["MANIFESTED", "IN_TRANSIT", "IN_TRANSIT_DS_TO_DS", "DEPARTED", "IN_TRANSIT_CUSTOMER_TO_DS", "IN_TRANSIT_DS_TO_FC"].includes(state)) return "transit";
  return "unmapped"; // Preserve the real source label; never invent a shipment status.
}
export function captureEddMovement(packages: EddPackage[], day: string, now = Date.now()) {
  const movement: EddMovement = { total: 0, atStation: 0, onRoad: 0, delivered: 0, exceptions: 0, transit: 0, unmapped: 0, pending: 0, stationReturns: 0, statuses: [] };
  const details: EddCheckpointPackage[] = [];
  const statuses = new Map<string, number>();
  for (const pkg of new Map(packages.filter(p => p.trackingId).map(p => [p.trackingId, p])).values()) {
    if (!isForwardEdd(pkg) || stationEddDate(pkg) !== day) continue;
    const status = pkg.sourceMissing ? "" : eddCurrentState(pkg), group = eddMovementGroup(pkg);
    const lifecycle = eddAttemptLifecycle(pkg), pending = stationEddPosition(pkg, day, now) === "atStation";
    movement.total++; movement[group]++;
    if (pending) movement.pending++;
    if (group === "atStation" && pkg.verification?.firstDispatchAt) movement.stationReturns++;
    if (status) statuses.set(status, (statuses.get(status) ?? 0) + 1);
    details.push([pkg.trackingId, status, group, pkg.driverName || pkg.driverId || "", pkg.sourceAt || "", lifecycle.category, pending]);
  }
  movement.statuses = [...statuses].map(([status, count]) => ({ status, count })).sort((a,b) => b.count-a.count);
  details.sort((a,b) => a[0].localeCompare(b[0], "en", { numeric: true }));
  return { movement, details };
}
export function selectEddCheckpointPackages(details: EddCheckpointPackage[], group: string, query = "") {
  const q = query.trim().toLowerCase();
  return details.filter(row => {
    const matchesGroup = group === "all" || (group === "pending" ? row[6] : row[2] === group);
    return matchesGroup && (!q || [row[0], row[1], row[3]].some(value => value.toLowerCase().includes(q)));
  });
}
export function eddCheckpointExportRows(details: EddCheckpointPackage[], station: string, day: string, observedAt: string) {
  return details.map(row => ({ Station: station, "EDD date IST": day, "Tracking ID": row[0],
    "Status at checkpoint": row[1], "Movement group": EDD_MOVEMENT_GROUPS.find(([key]) => key === row[2])?.[1] || "See source status",
    Associate: row[3], "Prior attempt classification": row[5], "Fresh EDD pending": row[6] ? "Yes" : "Not established / not applicable",
    "Source observation UTC": row[4], "Checkpoint observation UTC": observedAt }));
}
