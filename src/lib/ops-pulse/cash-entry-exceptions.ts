import { withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * "Enter cash later" exception for one required associate on one station-day.
 *
 * Some Amazon access-point / store partners only bring their COD cash to the station the
 * next day. Without this, Executive Reconciliation Step 1 blocks the whole station from
 * moving to Step 2 until every required associate (including that store) has a saved cash
 * row — which is wrong when the store genuinely hasn't been able to hand over cash yet.
 *
 * An open exception lets Step 1 -> Step 2 proceed for the rest of the station, but Step 2 ->
 * Step 3 (and final submission) stays blocked until the excepted associate's cash is actually
 * entered — at which point saveExecutiveReconciliation auto-clears the exception.
 */
export type CashEntryException = {
  id: string;
  businessDate: string;
  locationId: string;
  stationCode: string;
  providerEmployeeId: string;
  associateName: string;
  expectedAmount: number;
  reason: string;
  status: "Open" | "Cleared";
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  clearedAt: string | null;
};

type RawCashEntryExceptionRow = {
  id: string;
  business_date: string;
  location_id: string;
  station_code: string;
  provider_employee_id: string;
  associate_name: string;
  expected_amount: number | string | null;
  reason: string;
  status: "Open" | "Cleared";
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  cleared_at: string | null;
};

function normalize(row: RawCashEntryExceptionRow): CashEntryException {
  return {
    id: row.id,
    businessDate: row.business_date,
    locationId: row.location_id,
    stationCode: row.station_code,
    providerEmployeeId: row.provider_employee_id,
    associateName: row.associate_name,
    expectedAmount: Number(row.expected_amount ?? 0) || 0,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    clearedAt: row.cleared_at
  };
}

const SELECT_COLUMNS =
  "id, business_date, location_id, station_code, provider_employee_id, associate_name, expected_amount, reason, status, created_by, created_by_name, created_at, cleared_at";

/** Open exceptions for a station-day, or across every station in scope for the Step 2 panel / gating. */
export async function loadOpenCashEntryExceptions(
  companyId: string,
  businessDate: string,
  locationIds: string[]
): Promise<{ rows: CashEntryException[]; error: string | null }> {
  if (!supabaseAdmin || !businessDate || !locationIds.length) {
    return { rows: [], error: null };
  }
  const { data, error } = await supabaseAdmin
    .from("cod_cash_entry_exceptions")
    .select(SELECT_COLUMNS)
    .eq("company_id", companyId)
    .eq("business_date", businessDate)
    .eq("status", "Open")
    .in("location_id", locationIds)
    .order("created_at", { ascending: false });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map(normalize), error: null };
}

/** Add (or refresh) an open "will submit later" exception for one associate on one station-day. */
export async function addCashEntryException(params: {
  companyId: string;
  businessDate: string;
  locationId: string;
  stationCode: string;
  providerEmployeeId: string;
  associateName: string;
  expectedAmount: number;
  reason: string;
  createdBy: string;
  createdByName: string | null;
}): Promise<CashEntryException> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const providerEmployeeId = params.providerEmployeeId.trim();
  if (!providerEmployeeId) throw new Error("Associate is required for a cash entry exception.");
  if (!params.reason.trim()) throw new Error("Add a reason (e.g. \"Store will submit cash tomorrow\") for the exception.");

  const existing = await supabaseAdmin
    .from("cod_cash_entry_exceptions")
    .select("id")
    .eq("company_id", params.companyId)
    .eq("business_date", params.businessDate)
    .eq("location_id", params.locationId)
    .eq("provider_employee_id", providerEmployeeId)
    .eq("status", "Open")
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const payload = withCompany({
    business_date: params.businessDate,
    location_id: params.locationId,
    station_code: params.stationCode,
    provider_employee_id: providerEmployeeId,
    associate_name: params.associateName,
    expected_amount: params.expectedAmount,
    reason: params.reason.trim(),
    status: "Open" as const,
    created_by: params.createdBy,
    created_by_name: params.createdByName,
    cleared_at: null,
    updated_at: now
  }, params.companyId);

  const result = existing.data?.id
    ? await supabaseAdmin
      .from("cod_cash_entry_exceptions")
      .update(payload)
      .eq("id", existing.data.id)
      .select(SELECT_COLUMNS)
      .single()
    : await supabaseAdmin
      .from("cod_cash_entry_exceptions")
      .insert({ ...payload, id: crypto.randomUUID(), created_at: now })
      .select(SELECT_COLUMNS)
      .single();
  if (result.error) throw new Error(result.error.message);
  return normalize(result.data as RawCashEntryExceptionRow);
}

/**
 * Best-effort: clear any open exception for this associate once their cash is actually saved.
 * Never throws — a save must succeed even if this bookkeeping call fails.
 */
export async function clearCashEntryExceptionIfAny(
  companyId: string,
  businessDate: string,
  locationId: string,
  providerEmployeeId: string
): Promise<void> {
  if (!supabaseAdmin) return;
  const id = providerEmployeeId.trim();
  if (!id) return;
  try {
    await supabaseAdmin
      .from("cod_cash_entry_exceptions")
      .update({ status: "Cleared", cleared_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .eq("provider_employee_id", id)
      .eq("status", "Open");
  } catch (error) {
    console.error("clearCashEntryExceptionIfAny failed", error instanceof Error ? error.message : error);
  }
}
