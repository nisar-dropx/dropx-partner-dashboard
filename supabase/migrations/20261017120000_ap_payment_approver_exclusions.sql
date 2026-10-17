-- Keep product access and payment approval responsibility separate. This
-- master allows a person to retain Operations / Recruit / Workforce access
-- while being excluded from payment routing for selected locations.
begin;

create table if not exists public.payment_approver_exclusions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid references public.stations(id) on delete cascade,
  workflow_code text not null default 'payments',
  reason text not null,
  effective_from date not null default current_date,
  effective_until date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_approver_exclusions_dates check (effective_until is null or effective_until >= effective_from),
  constraint payment_approver_exclusions_workflow check (workflow_code = 'payments')
);

create unique index if not exists payment_approver_exclusions_active_unique
  on public.payment_approver_exclusions(company_id, profile_id, workflow_code, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_active;
create index if not exists payment_approver_exclusions_route_idx
  on public.payment_approver_exclusions(company_id, workflow_code, location_id, profile_id)
  where is_active;

alter table public.payment_approver_exclusions enable row level security;
revoke all on public.payment_approver_exclusions from anon, authenticated;
grant all on public.payment_approver_exclusions to service_role;

comment on table public.payment_approver_exclusions is
  'Configurable per-location payment routing exclusions. Product access remains unchanged.';

-- Management decision, 17-Oct-2026: remove Nagoor Praveen Kumar from payment
-- approvals for every station in his current Andhra Pradesh Operations scope.
insert into public.payment_approver_exclusions
  (company_id, profile_id, location_id, workflow_code, reason, effective_from)
select m.company_id, m.user_id, station_id, 'payments',
  'Management decision: AP payments route Cluster Manager directly to Business Head', current_date
from public.company_product_memberships m
cross join lateral unnest(m.location_scope_ids) station_id
where m.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
  and m.user_id = 'b28bc14b-d397-4e36-b930-2837abe8e046'::uuid
  and m.product_code = 'operations'
  and m.role_id = 'd128b2f2-8fe3-44e3-968e-5e0515af309b'::uuid
  and m.is_active
  and not exists (
    select 1 from public.payment_approver_exclusions existing
    where existing.company_id = m.company_id
      and existing.profile_id = m.user_id
      and existing.location_id = station_id
      and existing.workflow_code = 'payments'
      and existing.is_active
  );

-- Requests already waiting at the optional AOM stage are advanced to the
-- configured Business Head. No approval is fabricated and approval history is
-- preserved; the Business Head must still take the final decision.
with target_business_head as (
  select membership.company_id, membership.user_id, membership.role_id
  from public.company_product_memberships membership
  join public.user_roles role on role.id = membership.role_id and role.company_id = membership.company_id
  join public.profiles profile on profile.id = membership.user_id and profile.company_id = membership.company_id
  where membership.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
    and membership.product_code = 'operations'
    and membership.is_active
    and profile.is_active
    and role.code = 'OPERATIONS_BH'
  order by profile.full_name, membership.created_at
  limit 1
), target_scope as (
  select location_id
  from public.payment_approver_exclusions
  where company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
    and profile_id = 'b28bc14b-d397-4e36-b930-2837abe8e046'::uuid
    and workflow_code = 'payments' and is_active
), business_head_step as (
  select step.payment_head_id, step.step_order
  from public.payment_head_approval_steps step
  join target_business_head target on target.company_id = step.company_id
  where step.candidates @> jsonb_build_array(jsonb_build_object('role_id', target.role_id::text, 'scope', 'company'))
)
update public.payment_requests request
set current_step_order = business_head_step.step_order,
    current_approver_user_id = target.user_id,
    current_approver_role_id = target.role_id,
    current_approver_role_ids = array[target.role_id],
    approval_routing_reason = 'AP AOM removed by management; Cluster Manager approval retained and request advanced to Business Head',
    email_next_reminder_at = null,
    updated_at = now(),
    updated_by = null
from target_business_head target
join business_head_step on true
where request.company_id = target.company_id
  and request.payment_head_id = business_head_step.payment_head_id
  and request.location_id in (select location_id from target_scope)
  and (
    request.current_approver_user_id = 'b28bc14b-d397-4e36-b930-2837abe8e046'::uuid
    or (
      request.current_approver_role_id = 'd128b2f2-8fe3-44e3-968e-5e0515af309b'::uuid
      and request.approval_routing_reason like 'Leave / acting cover: NAGOOR PRAVEEN KUMAR → %'
    )
  )
  and lower(coalesce(request.status,'')) not in ('approved','processed','processing','returned','rejected','cancelled')
  and upper(coalesce(request.approval_status,request.status,'')) not in
    ('FINAL_APPROVED','OWNER_APPROVED','RE_APPROVED','PROCESSED','PROCESSING','RETURNED','REJECTED','CANCELLED');

commit;
