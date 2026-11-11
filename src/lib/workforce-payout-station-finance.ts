import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import type {
  WorkforcePayoutAudience,
  WorkforceStationFinanceRequest,
  WorkforceStationReleaseState
} from "@/lib/workforce-payout-station-finance-types";

export type {
  WorkforcePayoutAudience,
  WorkforceStationFinanceRequest,
  WorkforceStationReleaseState
} from "@/lib/workforce-payout-station-finance-types";

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function assertStationScope(authorization: AuthorizationContext, stationIds: string[]) {
  if (authorization.hasAllLocationAccess) return;
  const allowed = new Set(authorization.locationScopeIds.map((id) => id.toLowerCase()));
  for (const stationId of stationIds) {
    if (!uuid(stationId) || !allowed.has(stationId.toLowerCase())) {
      throw new Error("One or more selected stations are outside your access.");
    }
  }
}

export async function loadWorkforceStationReleaseStates(input: {
  companyId: string;
  audience: WorkforcePayoutAudience;
  periodStart: string;
  periodEnd: string;
  stationIds?: string[];
}) {
  if (!supabaseAdmin) return { releases: [] as WorkforceStationReleaseState[], error: "Database configuration is unavailable." };
  let query = supabaseAdmin
    .from("workforce_payout_station_releases")
    .select("station_id,worksheet_hash,row_count,amount_paise,released_at,released_by")
    .eq("company_id", input.companyId)
    .eq("audience", input.audience)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .order("station_id");
  if (input.stationIds?.length) query = query.in("station_id", input.stationIds);
  const result = await readAllRows(query);
  if (result.error) {
    if (/workforce_payout_station_releases|schema cache|does not exist/i.test(result.error.message)) {
      return { releases: [] as WorkforceStationReleaseState[], error: null as string | null };
    }
    return { releases: [] as WorkforceStationReleaseState[], error: result.error.message };
  }

  const enquiryChecks = await Promise.all((result.data ?? []).map(async (row) => {
    const recorded = await supabaseAdmin!.rpc("workforce_payout_station_bank_enquiry_recorded", {
      p_company: input.companyId,
      p_audience: input.audience,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_station: row.station_id
    });
    return {
      stationId: String(row.station_id),
      canReopen: recorded.error ? false : recorded.data !== true
    };
  }));
  const reopenByStation = new Map(enquiryChecks.map((entry) => [entry.stationId.toLowerCase(), entry.canReopen]));

  return {
    releases: (result.data ?? []).map((row) => ({
      stationId: String(row.station_id),
      worksheetHash: String(row.worksheet_hash ?? ""),
      rowCount: Number(row.row_count ?? 0),
      amountPaise: Number(row.amount_paise ?? 0),
      releasedAt: String(row.released_at ?? ""),
      releasedBy: String(row.released_by ?? ""),
      canReopen: reopenByStation.get(String(row.station_id).toLowerCase()) !== false
    })),
    error: null as string | null
  };
}

export async function loadWorkforceStationFinanceRequests(input: {
  companyId: string;
  audience: WorkforcePayoutAudience;
  periodStart: string;
  periodEnd: string;
}) {
  if (!supabaseAdmin) return { requests: [] as WorkforceStationFinanceRequest[], error: "Database configuration is unavailable." };
  const result = await readAllRows(supabaseAdmin
    .from("workforce_payout_finance_requests")
    .select("id,station_id,status,worksheet_hash,row_count,amount_paise,version,submitted_by,submitted_at,reviewed_by,reviewed_at,review_note")
    .eq("company_id", input.companyId)
    .eq("audience", input.audience)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .order("station_id"));
  if (result.error) {
    if (/workforce_payout_finance_requests|schema cache|does not exist/i.test(result.error.message)) {
      return { requests: [] as WorkforceStationFinanceRequest[], error: null as string | null };
    }
    return { requests: [] as WorkforceStationFinanceRequest[], error: result.error.message };
  }

  return {
    requests: (result.data ?? []).map((row) => ({
      id: String(row.id),
      stationId: String(row.station_id),
      status: String(row.status) as WorkforceStationFinanceRequest["status"],
      worksheetHash: String(row.worksheet_hash ?? ""),
      rowCount: Number(row.row_count ?? 0),
      amountPaise: Number(row.amount_paise ?? 0),
      version: Number(row.version ?? 1),
      submittedBy: String(row.submitted_by ?? ""),
      submittedAt: String(row.submitted_at ?? ""),
      reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
      reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
      reviewNote: String(row.review_note ?? ""),
      // Live drift is resolved by comparing against the station release hash in the API.
      changed: false
    })),
    error: null as string | null
  };
}

export async function assertWorkforceStationsFinanceReady(input: {
  companyId: string;
  audience: WorkforcePayoutAudience;
  periodStart: string;
  periodEnd: string;
  stationIds: string[];
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  for (const stationId of [...new Set(input.stationIds.map((id) => id.toLowerCase()))]) {
    const result = await supabaseAdmin.rpc("assert_workforce_payout_station_finance_ready", {
      p_company: input.companyId,
      p_audience: input.audience,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_station: stationId
    });
    if (result.error) {
      throw new Error(result.error.code === "P0001"
        ? result.error.message
        : "Station Finance approval could not be verified. Bank download is blocked.");
    }
  }
}
