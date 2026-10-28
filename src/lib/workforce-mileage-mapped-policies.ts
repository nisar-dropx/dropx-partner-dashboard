export type MappedMileageMapping = {
  id: string;
  station_id: string;
  workforce_id: string | null;
  payment_values: Record<string, unknown> | null;
  effective_from: string;
  effective_to: string | null;
  status: string;
  provider_member_id?: string | null;
};

export type MappedMileageStationTerm = {
  stationId: string;
  ratePerKm: number;
  rateConflict: boolean;
  rates: number[];
  mappedCount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  openEnded: boolean;
};

function mappedKilometreRate(mapping: Pick<MappedMileageMapping, "payment_values">): number | null {
  const entry = Object.entries(mapping.payment_values ?? {}).find(([code]) => code.trim().toUpperCase() === "KM_RUN");
  if (!entry || entry[1] === null || entry[1] === "") return null;
  const value = Number(entry[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Aggregate provider mappings with a positive KM_RUN rate into station mileage terms. */
export function aggregateMappedMileageTerms(mappings: MappedMileageMapping[]): MappedMileageStationTerm[] {
  const byStation = new Map<string, {
    rates: Set<number>;
    mapped: Set<string>;
    from: string;
    to: string | null;
    openEnded: boolean;
  }>();

  for (const mapping of mappings) {
    if (!mapping.station_id) continue;
    if (!["active", "closed"].includes(mapping.status)) continue;
    const rate = mappedKilometreRate(mapping);
    if (rate === null) continue;
    const workerKey = mapping.workforce_id ?? mapping.id;
    const current = byStation.get(mapping.station_id) ?? {
      rates: new Set<number>(),
      mapped: new Set<string>(),
      from: mapping.effective_from,
      to: mapping.effective_to,
      openEnded: mapping.effective_to == null
    };
    current.rates.add(rate);
    current.mapped.add(workerKey);
    if (mapping.effective_from < current.from) current.from = mapping.effective_from;
    if (mapping.effective_to == null) {
      current.openEnded = true;
      current.to = null;
    } else if (!current.openEnded && (current.to == null || mapping.effective_to > current.to)) {
      current.to = mapping.effective_to;
    }
    byStation.set(mapping.station_id, current);
  }

  return [...byStation.entries()]
    .map(([stationId, value]) => {
      const rates = [...value.rates].sort((a, b) => a - b);
      const modal = rates.length === 1
        ? rates[0]
        : rates[Math.floor((rates.length - 1) / 2)];
      return {
        stationId,
        ratePerKm: modal,
        rateConflict: rates.length > 1,
        rates,
        mappedCount: value.mapped.size,
        effectiveFrom: value.from,
        effectiveTo: value.openEnded ? null : value.to,
        openEnded: value.openEnded
      };
    })
    .sort((left, right) => left.stationId.localeCompare(right.stationId));
}
