type Row = Record<string, unknown>;

export type PayoutMappingRevisionState = {
  openPeriodKeys: Set<string>;
  activeStationIdsByPeriod: Map<string, Set<string>>;
  mappingRelockIdsByPeriod: Map<string, string>;
};

export function payoutMappingPeriodKey(periodStart: unknown, periodEnd: unknown) {
  const from = String(periodStart ?? "").trim();
  const to = String(periodEnd ?? "").trim();
  return from && to ? `${from}|${to}` : "";
}

/**
 * Parses the canonical database projection. The RPC resolves open corrections
 * for both their original Workforce ID and the current owner of each unlocked
 * provider key, and returns only the latest relock manifest for every period.
 */
export function payoutMappingRevisionState(rows: readonly Row[]): PayoutMappingRevisionState {
  const openPeriodKeys = new Set<string>();
  const activeStationIdsByPeriod = new Map<string, Set<string>>();
  const mappingRelockIdsByPeriod = new Map<string, string>();
  for (const row of rows) {
    const key = payoutMappingPeriodKey(row.period_start, row.period_end);
    if (!key) continue;
    if (row.revision_pending === true) openPeriodKeys.add(key);
    const hasRelock = row.mapping_relock_id !== null && row.mapping_relock_id !== undefined
      || row.active_station_ids !== null && row.active_station_ids !== undefined;
    if (hasRelock) {
      mappingRelockIdsByPeriod.set(key, String(row.mapping_relock_id ?? "").trim());
      const values = Array.isArray(row.active_station_ids) ? row.active_station_ids : [];
      activeStationIdsByPeriod.set(
        key,
        new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean)),
      );
    }
  }

  return { openPeriodKeys, activeStationIdsByPeriod, mappingRelockIdsByPeriod };
}

export function payoutMappingPublicationState(
  state: PayoutMappingRevisionState,
  periodStart: unknown,
  periodEnd: unknown,
  stationId: unknown,
  mappingRelockId: unknown,
) {
  const key = payoutMappingPeriodKey(periodStart, periodEnd);
  const activeStationIds = key ? state.activeStationIdsByPeriod.get(key) : undefined;
  const hasRelock = Boolean(key && state.mappingRelockIdsByPeriod.has(key));
  const requiredRelockId = key ? state.mappingRelockIdsByPeriod.get(key) : undefined;
  const station = String(stationId ?? "").trim();
  const publicationRelockId = String(mappingRelockId ?? "").trim();
  return {
    revisionPending: Boolean(key && state.openPeriodKeys.has(key)),
    visible: (!hasRelock || (Boolean(requiredRelockId) && publicationRelockId === requiredRelockId))
      && (!activeStationIds || (Boolean(station) && activeStationIds.has(station))),
  };
}

export async function loadPayoutMappingRevisionState(db: any, companyId: string, workforceId: string) {
  const result = await db.rpc("workforce_payout_mapping_revision_state", {
    p_company_id: companyId,
    p_workforce_id: workforceId,
  }, { get: true }); // STABLE read-only RPC; also safe in View as user preview.
  if (result.error) {
    throw new Error("Payout mapping revision details could not be loaded. Please retry.");
  }
  return payoutMappingRevisionState((result.data ?? []) as Row[]);
}
