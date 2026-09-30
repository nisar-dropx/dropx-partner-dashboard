-- Legacy payment rows may have reached a final manager decision before the
-- former Finance approval was removed. Finance processes those payments; it
-- must not keep an already-approved request open.

begin;

with finance_roles as (
  select id
  from public.user_roles
  where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    and is_active
    and code in ('OPERATIONS_FINMGR', 'OPERATIONS_ACCOUNTS', 'FINANCE_FINMGR',
                 'FINANCE_ACCOUNTS', 'FINANCE_ACE', 'ACCOUNTS', 'WORKFORCE_ACCOUNTS')
), finance_only_waiting as (
  select request.id, request.request_no, request.status as previous_status,
         request.approval_status as previous_approval_status
  from public.payment_requests request
  where request.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    and upper(coalesce(request.status, '')) not in
        ('APPROVED', 'FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
    and upper(coalesce(request.approval_status, '')) = 'APPROVED'
    and request.current_approver_role_id in (select id from finance_roles)
), finalized as (
  update public.payment_requests request
  set status = 'approved',
      approval_status = 'FINAL_APPROVED',
      current_step_order = greatest(coalesce(request.current_step_order, 1), 1),
      total_steps = greatest(coalesce(request.total_steps, 0), coalesce(request.current_step_order, 1), 1),
      current_approver_user_id = null,
      current_approver_role_id = null,
      current_approver_role_ids = '{}'::uuid[],
      email_next_reminder_at = null,
      updated_at = now()
  from finance_only_waiting
  where request.id = finance_only_waiting.id
  returning request.id, finance_only_waiting.request_no,
    finance_only_waiting.previous_status, finance_only_waiting.previous_approval_status
)
insert into public.payment_audit_events (request_id, event, actor_role, remarks)
select
  finalized.id,
  'legacy_finance_approval_removed_request_finalized',
  'SYSTEM_MIGRATION',
  jsonb_build_object(
    'request_no', finalized.request_no,
    'previous_status', finalized.previous_status,
    'previous_approval_status', finalized.previous_approval_status,
    'reason', 'Final manager decision was already complete; Finance is payment processing only'
  )::text
from finalized;

commit;
