-- Keep open requests' displayed workflow progress aligned with the active
-- payment-head step configuration. Approval routing already resolves from
-- the current configured steps; stale cached totals created impossible UI
-- progress such as "step 4 of 3" and labelled a final assignee as initial.
-- Do not rewrite terminal or legacy two-phase requests.

begin;

with configured_workflows as (
  select
    step.company_id,
    step.payment_head_id,
    count(*)::int as step_count,
    jsonb_agg(
      jsonb_build_object(
        'step_order', step.step_order,
        'candidates', step.candidates,
        'is_required', step.is_required
      )
      order by step.step_order
    ) as step_snapshot
  from public.payment_head_approval_steps step
  group by step.company_id, step.payment_head_id
), candidates as (
  select
    request.id,
    request.request_no,
    request.total_steps as previous_total_steps,
    request.current_step_order,
    workflow.step_count,
    workflow.step_snapshot
  from public.payment_requests request
  join configured_workflows workflow
    on workflow.company_id = request.company_id
   and workflow.payment_head_id = request.payment_head_id
  where upper(coalesce(request.status, '')) not in
      ('APPROVED', 'FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
    and upper(coalesce(request.approval_status, '')) not in
      ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
    -- A reduced workflow must never overwrite a request that is already at a
    -- higher historical step; that case requires an explicit routing decision.
    and coalesce(request.current_step_order, 1) <= workflow.step_count
    and coalesce(request.total_steps, 0) <> workflow.step_count
), repaired as (
  update public.payment_requests request
  set total_steps = candidates.step_count,
      approval_steps_snapshot = candidates.step_snapshot,
      updated_at = now()
  from candidates
  where request.id = candidates.id
  returning request.id, candidates.request_no, candidates.previous_total_steps,
    candidates.step_count, candidates.current_step_order
)
insert into public.payment_audit_events (request_id, event, actor_role, remarks)
select
  repaired.id,
  'approval_progress_reconciled',
  'SYSTEM_MIGRATION',
  jsonb_build_object(
    'request_no', repaired.request_no,
    'previous_total_steps', repaired.previous_total_steps,
    'current_step_order', repaired.current_step_order,
    'configured_total_steps', repaired.step_count,
    'reason', 'Cached workflow total was stale while the request follows the active approval configuration'
  )::text
from repaired;

commit;
