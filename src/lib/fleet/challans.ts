import "server-only";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type FleetChallanStatus =
  | "pending_review"
  | "disputed"
  | "approved_for_recovery"
  | "recovering"
  | "recovered"
  | "disposed"
  | "cancelled"
  | "paid_external";

export type FleetChallan = {
  id: string;
  vehicleId: string;
  vehicleNo: string;
  stationCode: string;
  stateCode: string;
  challanNumber: string;
  offenseAt: string | null;
  offenseDate: string | null;
  offenseDescription: string;
  issuingAuthority: string;
  amount: number;
  status: FleetChallanStatus;
  source: string;
  evidenceUrl: string;
  driveFileId: string;
  driveViewUrl: string;
  driveMimeType: string;
  responsibleNote: string;
  recoveryMonth: string | null;
  recoveryCaseKey: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FleetChallanEvent = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string;
  note: string;
  createdAt: string;
};

const text = (value: unknown) => String(value ?? "").trim();

export function mapFleetChallan(row: any): FleetChallan {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicleNo: text(row.vehicle_no).toUpperCase(),
    stationCode: text(row.station_code).toUpperCase(),
    stateCode: text(row.state_code).toUpperCase(),
    challanNumber: text(row.challan_number).toUpperCase(),
    offenseAt: row.offense_at ?? null,
    offenseDate: row.offense_date ?? null,
    offenseDescription: text(row.offense_description),
    issuingAuthority: text(row.issuing_authority) || "unknown",
    amount: Number(row.amount) || 0,
    status: row.status,
    source: text(row.source) || "manual",
    evidenceUrl: text(row.evidence_url),
    driveFileId: text(row.drive_file_id),
    driveViewUrl: text(row.drive_view_url),
    driveMimeType: text(row.drive_mime_type),
    responsibleNote: text(row.responsible_note),
    recoveryMonth: row.recovery_month ?? null,
    recoveryCaseKey: row.recovery_case_key ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listFleetChallans(companyId: string, stationCodes: string[] | null) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  let query = supabaseAdmin
    .from("fleet_challans")
    .select(
      "id,vehicle_id,vehicle_no,station_code,state_code,challan_number,offense_at,offense_date,offense_description,issuing_authority,amount,status,source,evidence_url,drive_file_id,drive_view_url,drive_mime_type,responsible_note,recovery_month,recovery_case_key,reviewed_at,created_at,updated_at"
    )
    .eq("company_id", companyId)
    .order("offense_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (stationCodes) query = query.in("station_code", stationCodes.length ? stationCodes : ["__NONE__"]);
  const result = await readAllRows(query);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).map(mapFleetChallan);
}

export async function loadFleetChallan(companyId: string, challanId: string) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const result = await supabaseAdmin
    .from("fleet_challans")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", challanId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Challan was not found.");
  const events = await supabaseAdmin
    .from("fleet_challan_events")
    .select("id,action,from_status,to_status,actor_name,note,created_at")
    .eq("company_id", companyId)
    .eq("challan_id", challanId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (events.error) throw new Error(events.error.message);
  return {
    challan: mapFleetChallan(result.data),
    events: (events.data ?? []).map((row): FleetChallanEvent => ({
      id: row.id,
      action: text(row.action),
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorName: text(row.actor_name) || "Fleet user",
      note: text(row.note),
      createdAt: row.created_at
    }))
  };
}

export function challanStatusLabel(status: string) {
  switch (status) {
    case "pending_review":
      return "Pending review";
    case "disputed":
      return "Disputed";
    case "approved_for_recovery":
      return "Approved for recovery";
    case "recovering":
      return "Recovering";
    case "recovered":
      return "Recovered";
    case "disposed":
      return "Disposed / closed";
    case "cancelled":
      return "Cancelled";
    case "paid_external":
      return "Paid outside DropX";
    default:
      return status;
  }
}

// Challan recovery lives on its OWN screen, separate from the NL/SLP recovery ledger.
export function teamOpsRecoveryHref(month: string | null, caseKey: string | null) {
  if (!month || !caseKey) return "/ops-pulse/team-ops/losses/challan-recovery";
  const params = new URLSearchParams({ month, case: caseKey });
  return `/ops-pulse/team-ops/losses/challan-recovery?${params.toString()}`;
}

export async function resolveFleetStationCodes(
  authorization: { isMasterOwner: boolean; hasAllLocationAccess: boolean; locationScopeIds: string[] },
  companyId: string
) {
  if (authorization.isMasterOwner || authorization.hasAllLocationAccess) return null;
  if (!supabaseAdmin || !authorization.locationScopeIds.length) return [] as string[];
  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("station_code")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", authorization.locationScopeIds);
  if (error) return [] as string[];
  return Array.from(
    new Set((data ?? []).map((row) => text(row.station_code).toUpperCase()).filter(Boolean))
  );
}
