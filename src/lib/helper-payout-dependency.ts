import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

export type HelperPayoutDependencyIdentity = {
  helperId: string;
  stationId: string;
};

export type HelperPayoutDependencyState = HelperPayoutDependencyIdentity & {
  dependencyHash: string;
  sourceChangeId: string;
};

function identityKey(identity: HelperPayoutDependencyIdentity) {
  return `${identity.helperId.toLowerCase()}|${identity.stationId.toLowerCase()}`;
}

export function helperPayoutDependencyStateKey(state: HelperPayoutDependencyState[]) {
  return [...state]
    .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
    .map((row) => `${identityKey(row)}|${row.sourceChangeId}|${row.dependencyHash}`)
    .join("\n");
}

export async function loadHelperPayoutDependencyState(input: {
  companyId: string;
  periodEnd: string;
  periodStart: string;
  rows: HelperPayoutDependencyIdentity[];
}) {
  if (!supabaseAdmin) {
    return { data: null as HelperPayoutDependencyState[] | null, error: "Database connection is not configured." };
  }
  const requested = new Map(input.rows.map((row) => [identityKey(row), row]));
  if (!requested.size) {
    return { data: null as HelperPayoutDependencyState[] | null, error: "At least one Helper payout row is required." };
  }
  const result = await readAllRows(supabaseAdmin.rpc("helper_payout_dependency_state", {
    p_company_id: input.companyId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_rows: [...requested.values()].map((row) => ({
      helper_id: row.helperId,
      station_id: row.stationId
    }))
  }));
  if (result.error) return { data: null as HelperPayoutDependencyState[] | null, error: result.error.message };

  const rows: HelperPayoutDependencyState[] = [];
  const seen = new Set<string>();
  for (const raw of result.data ?? []) {
    const helperId = String(raw.helper_id ?? "").toLowerCase();
    const stationId = String(raw.station_id ?? "").toLowerCase();
    const dependencyHash = String(raw.payout_dependency_hash ?? "").toLowerCase();
    const sourceChangeId = String(raw.payout_source_change_id ?? "");
    const key = identityKey({ helperId, stationId });
    if (!requested.has(key) || seen.has(key)
      || !/^[0-9a-f]{32}$/.test(dependencyHash)
      || !/^[0-9]+$/.test(sourceChangeId)) {
      return { data: null as HelperPayoutDependencyState[] | null, error: "Helper payout dependency state is invalid." };
    }
    seen.add(key);
    rows.push({ helperId, stationId, dependencyHash, sourceChangeId });
  }
  if (seen.size !== requested.size) {
    return { data: null as HelperPayoutDependencyState[] | null, error: "Helper payout dependency state is incomplete." };
  }
  return { data: rows, error: null as string | null };
}

