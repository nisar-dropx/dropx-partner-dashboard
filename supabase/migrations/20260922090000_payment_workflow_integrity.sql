-- Make payment-head master approval roles the canonical route for all new and open payment requests.
-- Initial roles are one required initial stage; final roles are ordered fallbacks in one required final stage.
-- Payment processor roles are deliberately excluded from approval steps.

alter table public.payment_requests
  add column if not exists approval_steps_snapshot jsonb;

with canonical as (
  select
    h.company_id,
    h.id as payment_head_id,
    case when h.initial_approval_role_ids is null
      then array_remove(array[h.initial_approval_role_id], null)
      else h.initial_approval_role_ids
    end as initial_roles,
    case when h.final_approval_role_ids is null
      then array_remove(array[h.final_approval_role_id], null)
      else h.final_approval_role_ids
    end as final_roles
  from public.payment_heads h
  where h.is_active = true
), routes as (
  select
    c.*,
    case
      when cardinality(c.final_roles) = 0 then '[]'::jsonb
      when cardinality(c.initial_roles) = 0 then jsonb_build_array(
        jsonb_build_object(
          'step_order', 1,
          'candidates', (select jsonb_agg(jsonb_build_object('role_id', r::text, 'scope', 'company')) from unnest(c.final_roles) r),
          'is_required', true
        )
      )
      else jsonb_build_array(
        jsonb_build_object(
          'step_order', 1,
          'candidates', (select jsonb_agg(jsonb_build_object('role_id', r::text, 'scope', 'station')) from unnest(c.initial_roles) r),
          'is_required', true
        ),
        jsonb_build_object(
          'step_order', 2,
          'candidates', (select jsonb_agg(jsonb_build_object('role_id', r::text, 'scope', 'company')) from unnest(c.final_roles) r),
          'is_required', true
        )
      )
    end as steps
  from canonical c
)
delete from public.payment_head_approval_steps s
using routes r
where s.company_id = r.company_id
  and s.payment_head_id = r.payment_head_id;

with canonical as (
  select
    h.company_id,
    h.id as payment_head_id,
    case when h.initial_approval_role_ids is null then array_remove(array[h.initial_approval_role_id], null) else h.initial_approval_role_ids end as initial_roles,
    case when h.final_approval_role_ids is null then array_remove(array[h.final_approval_role_id], null) else h.final_approval_role_ids end as final_roles
  from public.payment_heads h where h.is_active = true
), routes as (
  select c.*, case
    when cardinality(c.final_roles) = 0 then '[]'::jsonb
    when cardinality(c.initial_roles) = 0 then jsonb_build_array(jsonb_build_object('step_order',1,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','company')) from unnest(c.final_roles) r),'is_required',true))
    else jsonb_build_array(
      jsonb_build_object('step_order',1,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','station')) from unnest(c.initial_roles) r),'is_required',true),
      jsonb_build_object('step_order',2,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','company')) from unnest(c.final_roles) r),'is_required',true)
    ) end as steps
  from canonical c
)
insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required)
select r.company_id, r.payment_head_id, (step.value->>'step_order')::integer, step.value->'candidates', (step.value->>'is_required')::boolean
from routes r
cross join lateral jsonb_array_elements(r.steps) step(value);

-- Freeze the corrected route for every non-terminal request. Later master-data edits must not move an in-flight request.
with canonical as (
  select h.company_id, h.id as payment_head_id,
    case when h.initial_approval_role_ids is null then array_remove(array[h.initial_approval_role_id], null) else h.initial_approval_role_ids end as initial_roles,
    case when h.final_approval_role_ids is null then array_remove(array[h.final_approval_role_id], null) else h.final_approval_role_ids end as final_roles
  from public.payment_heads h where h.is_active = true
), routes as (
  select c.*, case
    when cardinality(c.final_roles) = 0 then '[]'::jsonb
    when cardinality(c.initial_roles) = 0 then jsonb_build_array(jsonb_build_object('step_order',1,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','company')) from unnest(c.final_roles) r),'is_required',true))
    else jsonb_build_array(
      jsonb_build_object('step_order',1,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','station')) from unnest(c.initial_roles) r),'is_required',true),
      jsonb_build_object('step_order',2,'candidates',(select jsonb_agg(jsonb_build_object('role_id',r::text,'scope','company')) from unnest(c.final_roles) r),'is_required',true)
    ) end as steps
  from canonical c
), open_requests as (
  select pr.*, r.initial_roles, r.final_roles, r.steps,
    exists (
      select 1 from public.payment_request_approvals a
      where a.company_id=pr.company_id and coalesce(a.payment_request_id,a.request_id)=pr.id
        and coalesce(a.approval_cycle,1)=coalesce(pr.approval_cycle,1)
        and lower(coalesce(a.action,''))='approved'
        and a.approver_role_id = any(r.initial_roles)
    ) as initial_approved,
    exists (
      select 1 from public.payment_request_approvals a
      where a.company_id=pr.company_id and coalesce(a.payment_request_id,a.request_id)=pr.id
        and coalesce(a.approval_cycle,1)=coalesce(pr.approval_cycle,1)
        and lower(coalesce(a.action,''))='approved'
        and a.approver_role_id = any(r.final_roles)
    ) as final_approved
  from public.payment_requests pr join routes r on r.company_id=pr.company_id and r.payment_head_id=pr.payment_head_id
  where pr.status in ('pending','resubmitted') or pr.approval_status='NO_APPROVER_CONFIGURED'
)
update public.payment_requests pr
set approval_steps_snapshot=o.steps,
    total_steps=jsonb_array_length(o.steps),
    final_approval_role_id=o.final_roles[1],
    final_approval_role_ids=o.final_roles,
    status=case when o.final_approved then 'approved' when pr.status='resubmitted' then 'resubmitted' else 'pending' end,
    approval_status=case when cardinality(o.final_roles)=0 then 'NO_APPROVER_CONFIGURED' when o.final_approved then 'FINAL_APPROVED' when pr.status='resubmitted' then 'RE_PENDING' else 'PENDING' end,
    current_step_order=case when o.final_approved then jsonb_array_length(o.steps) when cardinality(o.initial_roles)>0 and not o.initial_approved then 1 else 2 end,
    current_approver_user_id=null,
    current_approver_role_id=case when o.final_approved or cardinality(o.final_roles)=0 then null when cardinality(o.initial_roles)>0 and not o.initial_approved then o.initial_roles[1] else o.final_roles[1] end,
    current_approver_role_ids=case when o.final_approved or cardinality(o.final_roles)=0 then '{}'::uuid[] when cardinality(o.initial_roles)>0 and not o.initial_approved then o.initial_roles else o.final_roles end,
    updated_at=now()
from open_requests o
where pr.id=o.id;

-- Terminal rows must never retain a pending approver assignment.
update public.payment_requests
set current_approver_user_id=null,
    current_approver_role_id=null,
    current_approver_role_ids='{}'::uuid[],
    updated_at=now()
where status in ('processed','rejected','returned','cancelled')
   or approval_status in ('FINAL_APPROVED','PROCESSED','REJECTED','RETURNED','CANCELLED');