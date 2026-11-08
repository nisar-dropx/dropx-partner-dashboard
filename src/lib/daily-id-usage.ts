import { workedIdCounts } from "./worked-id-review.ts";

export function dailyUsageDates(from: string, to: string) {
  const dates: string[] = [];
  for (let day = from; day <= to && dates.length < 31; ) {
    dates.push(day);
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  return dates;
}

/** Raw ID ownership stays unchanged; the shared review ledger reallocates units. */
export function dailyUsageShares(
  shipments: any[],
  reviews: any[],
  workers: Map<string, any>,
) {
  const bySource = new Map(shipments.map((s) => [s.id, s]));
  const incoming = new Map<string, any[]>(),
    outgoing = new Map<string, any[]>();
  for (const r of reviews.filter((r) => r.decision === "worked")) {
    for (const share of r.workforce_worked_id_shares || []) {
      const source = bySource.get(share.source_shipment_id);
      if (!source) continue;
      const owner = workers.get(share.owner_workforce_id),
        recipient = workers.get(r.workforce_id);
      const usage = {
        sourceId: source.id,
        providerId: source.provider_employee_id,
        providerName: source.provider_employee_name || "",
        client: source.client,
        ownerId: owner?.id,
        ownerName: owner?.full_name || "Owner unavailable",
        ownerDropxId: owner?.dropx_id,
        workerId: r.workforce_id,
        name: recipient?.full_name || "Associate unavailable",
        dropxId: recipient?.dropx_id,
        deliveries: Number(share.quantities.total_delivery || 0),
        ownerWorked: share.owner_worked,
        quantities: workedIdCounts(share.quantities),
      };
      const key = `${r.station_id}|${r.workforce_id}|${r.work_date}`;
      incoming.set(key, [...(incoming.get(key) || []), usage]);
      outgoing.set(source.id, [...(outgoing.get(source.id) || []), usage]);
    }
  }
  return { incoming, outgoing };
}

export function dailyUsageStatus(row: any) {
  if (row.paymentLocked || (row.lockReason && row.canAllocate !== false)) return "Payment locked";
  if (row.canAllocate === false) return "Non-delivery role · view only";
  if (row.ownerExcluded) return "Owner attendance excluded";
  if (row.decision === "not_worked") return "Marked absent";
  if (row.decision === "worked") return "Work allocated";
  if (row.bulkPeriods?.length) return "Bulk period";
  if (!row.hasPaySetup) return "Payment setup needed";
  if (!row.hasStationDeliveryData) return "Report missing";
  if (row.punches > 0 && row.ownDeliveries === 0)
    return "Punch, no own-ID deliveries";
  if (!row.punches && row.ownDeliveries > 0)
    return "Deliveries, no biometric punch";
  return row.punches || row.ownDeliveries
    ? "Evidence available"
    : "No daily evidence";
}
