-- Fleet approval remains master-driven. The local CLM/AOM stage is optional
-- only when neither role is mapped in People; the model-specific final stage
-- remains required and is never skipped.

update public.payment_head_approval_steps step
set is_required = false,
    updated_at = now()
from public.payment_heads head
where head.id = step.payment_head_id
  and head.company_id = step.company_id
  and head.is_active = true
  and step.step_order = 1
  and upper(head.code) in
    ('VAN_ADHOC', 'VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE');

update public.payment_requests request
set approval_steps_snapshot = configured.steps,
    updated_at = now()
from (
  select
    step.company_id,
    step.payment_head_id,
    jsonb_agg(
      jsonb_build_object(
        'step_order', step.step_order,
        'candidates', step.candidates,
        'is_required', step.is_required
      )
      order by step.step_order
    ) as steps
  from public.payment_head_approval_steps step
  join public.payment_heads head
    on head.company_id = step.company_id
   and head.id = step.payment_head_id
  where head.is_active = true
    and upper(head.code) in
      ('VAN_ADHOC', 'VAN_FUEL', 'VEHICLE_REPAIR', 'VEHICLE_SERVICE')
  group by step.company_id, step.payment_head_id
) configured
where request.company_id = configured.company_id
  and request.payment_head_id = configured.payment_head_id
  and request.adhoc_approval_steps is null
  and upper(coalesce(request.status, '')) not in
    ('APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED')
  and upper(coalesce(request.approval_status, '')) not in
    ('FINAL_APPROVED', 'PROCESSED', 'PROCESSING', 'RETURNED', 'REJECTED', 'CANCELLED');
