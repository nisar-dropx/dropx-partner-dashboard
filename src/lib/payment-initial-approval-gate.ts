import type { SupabaseClient } from "@supabase/supabase-js";
import { hasInitialApprovalForPersistedRequest, type ApprovalStage } from "./payment-stage-policy";

/** Fail closed if persisted routing jumped past every local approval. */
export async function initialApprovalReadyIds(companyId: string, requestIds: string[], supabaseAdmin: SupabaseClient | null) {
  const ready = new Set<string>();
  if (!supabaseAdmin || !requestIds.length) return ready;
  for (let offset = 0; offset < requestIds.length; offset += 100) {
    const ids = requestIds.slice(offset, offset + 100);
    const requests = await supabaseAdmin.from("payment_requests")
      .select("id,payment_head_id,current_step_order,total_steps")
      .eq("company_id", companyId).in("id", ids);
    if (requests.error) throw new Error(requests.error.message);
    const heads = [...new Set((requests.data ?? []).map(row => row.payment_head_id).filter(Boolean))];
    const steps = heads.length ? await supabaseAdmin.from("payment_head_approval_steps")
      .select("payment_head_id,step_order,candidates,is_required")
      .eq("company_id", companyId).in("payment_head_id", heads) : { data: [], error: null };
    if (steps.error) throw new Error(steps.error.message);
    const approvals: { payment_request_id: string; action: string; approver_role_id: string | null }[] = [];
    // Paginate history: never mistake a truncated response for no approval.
    for (let page = 0; ; page += 1000) {
      const logs = await supabaseAdmin.from("payment_request_approvals")
        .select("payment_request_id,action,approver_role_id")
        .eq("company_id", companyId).eq("action", "approved")
        .in("payment_request_id", ids).order("id").range(page, page + 999);
      if (logs.error) throw new Error(logs.error.message);
      approvals.push(...(logs.data ?? []));
      if ((logs.data?.length ?? 0) < 1000) break;
    }
    for (const request of requests.data ?? []) {
      const configuredSteps = (steps.data ?? []).filter(step => step.payment_head_id === request.payment_head_id) as ApprovalStage[];
      const recordedApprovals = approvals.filter(log => log.payment_request_id === request.id);
      if (hasInitialApprovalForPersistedRequest(
        configuredSteps,
        Number(request.current_step_order) || 1,
        Number(request.total_steps) || null,
        recordedApprovals
      )) ready.add(request.id);
    }
  }
  return ready;
}
