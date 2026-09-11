import type { EddPackage, EddPerformancePayload, EddStationPayload } from "./edd-worker";
import { eddCurrentState } from "./edd-verification";

/** Preserve the known cohort after deliveries disappear from the active stock
 * feed. Outcomes supply current state, never an invented EDD or scan history. */
export function mergeReviewEddCohort(retained: EddPackage[], stock: EddStationPayload | null, outcomes: EddPerformancePayload | null) {
  const rows = new Map(retained.map(pkg => [pkg.trackingId, { ...pkg }]));
  const observed = new Set<string>();
  for (const pkg of stock?.packages ?? []) {
    const prior = rows.get(pkg.trackingId);
    rows.set(pkg.trackingId, { ...prior, ...pkg, sourceAt: stock!.fetchedAt,
      state: prior && eddCurrentState(prior) === "DELIVERED" ? "DELIVERED" : pkg.state,
      verification: prior?.verification ?? pkg.verification ?? null,
      verifiedAt: prior?.verifiedAt ?? pkg.verifiedAt ?? null,
      driverName: pkg.driverName || prior?.driverName || prior?.verification?.driverName || null });
    observed.add(pkg.trackingId);
  }
  for (const outcome of outcomes?.packages ?? []) {
    if (!outcome.trackingId) continue;
    observed.add(outcome.trackingId);
    const prior = rows.get(outcome.trackingId);
    const empty: EddPackage = { trackingId: outcome.trackingId, state: null, ead: null, internalEAD: null,
      promisedDeliveryDate: null, estimatedArrivalTimeUTC: null, bucket: "unknown", minutesInState: 0,
      lastScanBy: null, driverId: null, dspName: null, paymentMethod: null, city: null, postalCode: null,
      stateProvinceCode: null, orderingOrderId: null, shipOption: null, packageType: null, lockerName: null };
    // A stock observation newer than this outcome wins, except terminal delivery.
    if (prior?.sourceAt && Date.parse(prior.sourceAt) > Date.parse(outcomes!.fetchedAt) && outcome.state !== "DELIVERED") continue;
    rows.set(outcome.trackingId, { ...(prior ?? empty), state: prior && eddCurrentState(prior) === "DELIVERED" ? "DELIVERED" : outcome.state,
      sourceAt: outcomes!.fetchedAt, driverId: outcome.driverId || prior?.driverId || null,
      driverName: outcome.driverName || prior?.driverName || null, isAccessPoint: outcome.isAccessPoint,
      orderingOrderId: outcome.orderingOrderId || prior?.orderingOrderId || null });
  }
  // Absence from a new stock snapshot does not mean delivered, dispatched or
  // still pending. Preserve terminal deliveries; withdraw other stale positions.
  if (stock) for (const [id, pkg] of rows) {
    if (!observed.has(id) && eddCurrentState(pkg) !== "DELIVERED") {
      rows.set(id, { ...pkg, state: "UNKNOWN", sourceAt: stock.fetchedAt,
        verification: pkg.verification ? { ...pkg.verification, state: "UNKNOWN" } : null });
    }
  }
  return [...rows.values()];
}
