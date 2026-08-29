-- Trace why a regularization is in manager vs HR queue.
-- Replace dropx_id before running.

with target as (
  select lower(btrim('D0915')) as reference
)
select
  request.id::text,
  request.full_name,
  request.dropx_id,
  request.attendance_date,
  request.status,
  request.attachment_path is not null as has_proof,
  request.created_at
from public.attendance_regularization_requests request
cross join target
where lower(btrim(request.dropx_id)) = target.reference
  and request.request_kind is null
order by request.created_at desc
limit 5;

with target as (
  select lower(btrim('D0915')) as reference
)
select
  step.id::text,
  step.request_id::text,
  step.step_order,
  step.step_name,
  step.status,
  step.approver_user_id::text,
  profile.full_name as approver_name,
  profile.email as approver_email
from public.attendance_regularization_approval_steps step
join public.attendance_regularization_requests request
  on request.id = step.request_id
cross join target
left join public.profiles profile
  on profile.id = step.approver_user_id
where lower(btrim(request.dropx_id)) = target.reference
order by step.step_order;
