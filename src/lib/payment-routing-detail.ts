import 'server-only';
import { supabaseAdmin } from './supabase-admin';
import { advanceApproval, loadApprovalSteps } from './payment-approval-steps';
import { isPendingPaymentApproval } from './payment-pending-approval';

/** Called only after the caller has authorized the request's company/location. */
export async function loadPaymentRoutingDetail(companyId: string, request: {
  id: string; payment_head_id: string; location_id: string | null;
  current_step_order: number | null; status: string; approval_status: string | null;
  current_approver_user_id: string | null;
}) {
  if (!supabaseAdmin) return null;
  try {
    const [events, history, steps] = await Promise.all([
      supabaseAdmin.from('payment_approval_routing_events').select('*')
        .eq('company_id', companyId).eq('payment_request_id', request.id).order('created_at'),
      supabaseAdmin.from('payment_request_approvals').select('action,approver_user_id,created_at')
        .eq('company_id', companyId).eq('payment_request_id', request.id).order('created_at'),
      loadApprovalSteps(companyId, request.payment_head_id, request.id)
    ]);
    if (events.error || history.error) throw new Error('Assignment history is temporarily unavailable.');
    const lastReset = (history.data ?? []).filter(row => ['returned','resubmitted','rejected'].includes(row.action)).at(-1)?.created_at;
    const approved = new Set<string>((history.data ?? []).filter(row => row.action === 'approved' && (!lastReset || row.created_at > lastReset)).map(row => row.approver_user_id).filter(Boolean));
    // Preview what follows the current holder's approval, including duplicate-stage skips.
    if (request.current_approver_user_id) approved.add(request.current_approver_user_id);
    const next = isPendingPaymentApproval(request) && steps.length
      ? await advanceApproval(companyId, steps, request.current_step_order ?? 1, request.location_id, approved) : null;
    const ids = [...new Set([next?.approver?.userId, ...(events.data ?? []).flatMap(row => [row.from_user_id,row.to_user_id,row.actor_user_id])].filter((id): id is string => Boolean(id)))];
    const profiles = ids.length ? await supabaseAdmin.from('profiles').select('id,full_name,email').eq('company_id',companyId).in('id',ids) : { data: [] };
    const names = new Map((profiles.data ?? []).map(row => [row.id,row.full_name || row.email || 'User']));
    return {
      nextLabel: next ? next.done ? 'Next: Finance processing after final approval.'
        : next.approver ? `Next: ${names.get(next.approver.userId) ?? 'Configured approver'} · stage ${next.nextStepOrder}. Based on current People assignments; leave cover may change.`
        : `Stage ${next.nextStepOrder} is required but has no eligible approver. Configure the role or leave cover before proceeding.`
        : 'See the request history for completed decisions and Finance processing.',
      error: null,
      events: (events.data ?? []).map(row => ({ id: row.id, from: names.get(row.from_user_id) ?? '—', to: names.get(row.to_user_id) ?? 'Unassigned / closed', step: row.to_step, reason: row.reason, actor: names.get(row.actor_user_id) ?? 'System', created_at: row.created_at }))
    };
  } catch {
    return { nextLabel: 'Route preview unavailable', error: 'Could not load the live route. The saved assignment above remains authoritative.', events: [] };
  }
}
