import { supabaseAdmin } from "@/lib/supabase-admin";
import { latestReturn } from "@/lib/payment-resubmission";

type Log = { id: string; action: string | null; comments: string | null; created_at: string; approver_user_id: string | null; approver_role_id: string | null };
export type ResubmissionEvent = Log & { actor: string; role: string };
export type ResubmissionContext = {
  events: ResubmissionEvent[];
  returned: ResubmissionEvent | null;
  reasonKey: string | null;
  vehicleContext: string[];
  originalRemarks: string | null;
  error: string | null;
};
/** Called only after the page checks company, location, initiator and returned status. */
export async function loadResubmissionContext(companyId: string, request: { id: string; requested_by: string | null; created_at: string; remarks: string | null }): Promise<ResubmissionContext> {
  const empty: ResubmissionContext = { events: [], returned: null, reasonKey: null, vehicleContext: [], originalRemarks: null, error: null };
  if (!supabaseAdmin) return { ...empty, error: "Request history is unavailable. Reload before resubmitting." };
  const admin = supabaseAdmin;
  const [logs, replacement] = await Promise.all([
    admin.from("payment_request_approvals").select("id,action,comments,created_at,approver_user_id,approver_role_id")
      .eq("company_id", companyId).or(`payment_request_id.eq.${request.id},request_id.eq.${request.id}`).order("created_at", { ascending: true }),
    admin.from("payment_requests").select("adhoc_reason_key,adhoc_vehicle_snapshot").eq("company_id", companyId).eq("id", request.id).single()
  ]);
  if (logs.error || replacement.error) return { ...empty, error: "Request history could not be loaded. Reload before resubmitting." };
  const rows = (logs.data ?? []) as Log[];
  const userIds = [...new Set([request.requested_by, ...rows.map(row => row.approver_user_id)].filter((id): id is string => Boolean(id)))];
  const roleIds = [...new Set(rows.map(row => row.approver_role_id).filter((id): id is string => Boolean(id)))];
  const [people, roles] = await Promise.all([
    userIds.length ? admin.from("profiles").select("id,full_name,email").eq("company_id", companyId).in("id", userIds) : Promise.resolve({ data: [], error: null }),
    roleIds.length ? admin.from("user_roles").select("id,name").eq("company_id", companyId).in("id", roleIds) : Promise.resolve({ data: [], error: null })
  ]);
  const names = new Map((people.data ?? []).map(row => [row.id, row.full_name || row.email || "Name unavailable"]));
  const roleNames = new Map((roles.data ?? []).map(row => [row.id, row.name || ""]));
  const events = rows.map(row => ({ ...row, actor: row.approver_user_id ? names.get(row.approver_user_id) ?? "Name unavailable" : "System", role: row.approver_role_id ? roleNames.get(row.approver_role_id) ?? "" : "" }));
  const created = events.find(row => String(row.action).toLowerCase() === "created");
  if (!created) events.unshift({ id: "request-created", action: "created", comments: null, created_at: request.created_at, approver_user_id: request.requested_by, approver_role_id: null, actor: request.requested_by ? names.get(request.requested_by) ?? "Name unavailable" : "Not recorded", role: "" });
  const snapshot = replacement.data?.adhoc_vehicle_snapshot;
  const vehicleContext = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? ["reason", "number", "model", "date"].map(key => (snapshot as Record<string, unknown>)[key]).filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
  return { vehicleContext, events, returned: latestReturn(events), reasonKey: replacement.data?.adhoc_reason_key ?? null, originalRemarks: created?.comments ?? null, error: people.error || roles.error ? "Some names could not be loaded. Reload before resubmitting." : null };
}
