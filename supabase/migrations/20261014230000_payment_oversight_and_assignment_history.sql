-- Read-only oversight is a role permission, independent of approval authority.
-- Initial grants are configuration only; later edits in Users & Access win.
insert into public.app_pages(company_id, code, name, sort_order, is_active)
select id, 'payment_oversight', 'Payment Oversight (view only)', 108, true
from public.companies
on conflict (company_id, code) do nothing;

insert into public.role_page_permissions(company_id, role_id, page_id, can_view, can_add, can_edit)
select r.company_id, r.id, p.id, true, false, false
from public.user_roles r
join public.app_pages p on p.company_id = r.company_id and p.code = 'payment_oversight'
where r.is_active and (
  r.code = 'OPERATIONS_HLM' or exists (
    select 1 from public.role_page_permissions g
    join public.app_pages a on a.id = g.page_id and a.company_id = r.company_id
    where g.company_id = r.company_id and g.role_id = r.id
      and a.code = 'payment_approvals' and g.can_edit
  )
)
on conflict (company_id, role_id, page_id) do nothing;

alter table public.payment_requests
  add column if not exists approval_pending_since timestamptz,
  add column if not exists approval_routing_reason text;
alter table public.payment_request_approvals
  add column if not exists approval_step_order integer;

-- Existing history gives the start of the current stage; updated_at can be a
-- reminder or an unrelated edit, so it must not be used as the waiting time.
update public.payment_requests r
set approval_pending_since = coalesce((
  select max(a.created_at) from public.payment_request_approvals a
  where a.company_id = r.company_id and a.payment_request_id = r.id
    and lower(a.action) in ('approved', 'resubmitted')
), r.created_at)
where r.approval_pending_since is null
  and upper(coalesce(r.status,'')) <> 'APPROVED'
  and upper(coalesce(r.approval_status, r.status, '')) not in
    ('FINAL_APPROVED','OWNER_APPROVED','RE_APPROVED','PROCESSED','PROCESSING','RETURNED','REJECTED','CANCELLED');

create table public.payment_approval_routing_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  from_user_id uuid,
  to_user_id uuid,
  from_role_id uuid,
  to_role_id uuid,
  from_step integer,
  to_step integer,
  reason text not null,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);
create index payment_approval_routing_request_idx on public.payment_approval_routing_events(company_id,payment_request_id,created_at);
alter table public.payment_approval_routing_events enable row level security;
revoke all on public.payment_approval_routing_events from anon, authenticated;
grant all on public.payment_approval_routing_events to service_role;

create function public.track_payment_approval_routing() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare changed boolean; terminal boolean; reason text;
begin
  terminal := upper(coalesce(new.status,'')) = 'APPROVED' or upper(coalesce(new.approval_status,new.status,'')) in
    ('FINAL_APPROVED','OWNER_APPROVED','RE_APPROVED','PROCESSED','PROCESSING','RETURNED','REJECTED','CANCELLED');
  if tg_op = 'INSERT' then
    new.approval_pending_since := case when terminal then null else now() end;
    new.approval_routing_reason := coalesce(new.approval_routing_reason, 'Initial assignment from configured approval route');
    return new;
  end if;
  changed := row(new.current_approver_user_id,new.current_approver_role_id,new.current_step_order,new.status,new.approval_status,new.approval_routing_reason)
    is distinct from row(old.current_approver_user_id,old.current_approver_role_id,old.current_step_order,old.status,old.approval_status,old.approval_routing_reason);
  if not changed then return new; end if;
  reason := case
    when new.approval_routing_reason is distinct from old.approval_routing_reason and nullif(new.approval_routing_reason,'') is not null then new.approval_routing_reason
    when terminal then 'Approval stage closed: ' || coalesce(new.approval_status,new.status)
    when new.current_step_order is distinct from old.current_step_order then 'Advanced to the next configured approval stage'
    when new.current_approver_user_id is null then 'No eligible approver: check required role, location access and leave cover'
    else 'Assignment refreshed from People and configured approval roles' end;
  new.approval_routing_reason := reason;
  if terminal then new.approval_pending_since := null;
  elsif new.current_step_order is distinct from old.current_step_order or old.approval_pending_since is null
    then new.approval_pending_since := now();
  else new.approval_pending_since := old.approval_pending_since; end if;
  insert into public.payment_approval_routing_events(company_id,payment_request_id,from_user_id,to_user_id,from_role_id,to_role_id,from_step,to_step,reason,actor_user_id)
  values(new.company_id,new.id,old.current_approver_user_id,new.current_approver_user_id,old.current_approver_role_id,new.current_approver_role_id,old.current_step_order,new.current_step_order,reason,new.updated_by);
  return new;
end; $$;
create trigger track_payment_approval_routing before insert or update on public.payment_requests
for each row execute function public.track_payment_approval_routing();

-- Record the actual stage at the time of approval, including acting cover.
create function public.record_payment_approval_stage() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.approval_step_order is null then
    select current_step_order into new.approval_step_order from public.payment_requests
    where company_id = new.company_id and id = new.payment_request_id;
  end if;
  return new;
end; $$;
create trigger record_payment_approval_stage before insert on public.payment_request_approvals
for each row execute function public.record_payment_approval_stage();
revoke all on function public.track_payment_approval_routing() from public,anon,authenticated;
revoke all on function public.record_payment_approval_stage() from public,anon,authenticated;
