begin;
-- Team Ops → Workforce payment holds, run like People salary holds.
--
--   raise ──► awaiting_approval ──CM approves──► active ──raiser asks──► release_requested ──CM approves──► released
--                  ├─reject──► rejected                                          └─reject──► active
--                  └─withdraw──► cancelled
--
-- Approval places the REAL payout hold (workforce_set_payout_payment_hold) for that calendar month, the
-- one the Workforce payout worksheet and bank file honour; approving the release lifts it. The older
-- workforce_payment_holds table was never read by payouts and is no longer written. Every step is one
-- row in ops_workforce_hold_events (immutable). The app checks that the actor is the station's cluster
-- manager (AOM fallback); this database never lets anyone decide their own request.

create table if not exists public.ops_workforce_hold_requests (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 workforce_id uuid not null,
 station_id uuid,
 period_start date not null check (extract(day from period_start) = 1),
 period_end date not null,
 reason text not null check (length(btrim(reason)) between 5 and 1000),
 status text not null default 'awaiting_approval' check (status in ('awaiting_approval','active','rejected','cancelled','release_requested','released')),
 raised_by uuid not null, raised_by_name text not null, raised_at timestamptz not null default now(),
 decided_by uuid, decided_by_name text, decided_at timestamptz, decision_note text,
 release_requested_by uuid, release_requested_at timestamptz, release_request_note text,
 released_by uuid, released_by_name text, released_at timestamptz, release_note text,
 hold_operation_id uuid, release_operation_id uuid,
 version int not null default 1,
 updated_at timestamptz not null default now(),
 check (period_end = (period_start + interval '1 month - 1 day')::date)
);
-- One open request per person per month.
create unique index if not exists ops_workforce_hold_one_open on public.ops_workforce_hold_requests(company_id, workforce_id, period_start)
 where status in ('awaiting_approval','active','release_requested');
create index if not exists ops_workforce_hold_station on public.ops_workforce_hold_requests(company_id, station_id, status, raised_at desc);

create table if not exists public.ops_workforce_hold_events (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null, request_id uuid not null references public.ops_workforce_hold_requests(id) on delete cascade,
 action text not null, from_status text, to_status text not null, actor_id uuid, actor_name text, note text,
 created_at timestamptz not null default now()
);
create index if not exists ops_workforce_hold_events_req on public.ops_workforce_hold_events(company_id, request_id, created_at);
create or replace function public.ops_workforce_hold_events_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'Hold history cannot be changed.'; end $$;
drop trigger if exists ops_workforce_hold_events_immutable on public.ops_workforce_hold_events;
create trigger ops_workforce_hold_events_immutable before update or delete on public.ops_workforce_hold_events for each row execute function public.ops_workforce_hold_events_immutable();

alter table public.ops_workforce_hold_requests enable row level security;
alter table public.ops_workforce_hold_events enable row level security;
revoke all on public.ops_workforce_hold_requests, public.ops_workforce_hold_events from public, anon, authenticated;
grant all on public.ops_workforce_hold_requests to service_role;
grant select, insert on public.ops_workforce_hold_events to service_role;

create or replace function public.ops_workforce_hold_raise(p_company uuid, p_workforce uuid, p_month date, p_reason text, p_actor uuid, p_name text)
returns public.ops_workforce_hold_requests language plpgsql security definer set search_path = public as $$
declare w record; saved ops_workforce_hold_requests; m date := date_trunc('month', p_month)::date;
begin
 select id, location_id into w from workforce where company_id = p_company and id = p_workforce and deleted_at is null;
 if not found then raise exception 'Choose a Workforce associate.'; end if;
 if p_month is null or m < (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '3 months')::date or m > (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month')::date then
  raise exception 'Choose a payout month from the last three months up to next month.';
 end if;
 if length(btrim(coalesce(p_reason, ''))) not between 5 and 1000 then raise exception 'Explain the reason for this hold (5–1,000 characters).'; end if;
 if exists (select 1 from ops_workforce_hold_requests where company_id = p_company and workforce_id = p_workforce and period_start = m and status in ('awaiting_approval','active','release_requested')) then
  raise exception 'This associate already has an open hold request for that month.';
 end if;
 insert into ops_workforce_hold_requests(company_id, workforce_id, station_id, period_start, period_end, reason, raised_by, raised_by_name)
 values (p_company, p_workforce, w.location_id, m, (m + interval '1 month - 1 day')::date, btrim(p_reason), p_actor, p_name) returning * into saved;
 insert into ops_workforce_hold_events(company_id, request_id, action, to_status, actor_id, actor_name, note) values (p_company, saved.id, 'raised', saved.status, p_actor, p_name, saved.reason);
 return saved;
end $$;

create or replace function public.ops_workforce_hold_transition(p_company uuid, p_request uuid, p_action text, p_version int, p_actor uuid, p_name text, p_note text default null)
returns public.ops_workforce_hold_requests language plpgsql security definer set search_path = public as $$
declare r ops_workforce_hold_requests; target text; note text := nullif(btrim(coalesce(p_note, '')), ''); saved ops_workforce_hold_requests; op uuid; result jsonb;
begin
 select * into r from ops_workforce_hold_requests where company_id = p_company and id = p_request for update;
 if not found then raise exception 'Hold request was not found.'; end if;
 if r.version <> p_version then raise exception 'Someone else updated this hold. Refresh and try again.'; end if;
 if note is not null and length(note) > 1000 then raise exception 'Keep the note under 1,000 characters.'; end if;
 target := case
  when p_action = 'approve' and r.status = 'awaiting_approval' then 'active'
  when p_action = 'reject' and r.status = 'awaiting_approval' then 'rejected'
  when p_action = 'withdraw' and r.status = 'awaiting_approval' then 'cancelled'
  when p_action = 'request_release' and r.status = 'active' then 'release_requested'
  when p_action = 'approve_release' and r.status = 'release_requested' then 'released'
  when p_action = 'reject_release' and r.status = 'release_requested' then 'active' end;
 if target is null then raise exception 'This hold is now %, so it cannot be changed this way. Refresh to see its latest state.', replace(r.status, '_', ' '); end if;
 if p_action in ('approve','reject') and p_actor = r.raised_by then raise exception 'You raised this hold, so the cluster manager must decide it.'; end if;
 if p_action in ('approve_release','reject_release') and p_actor = r.release_requested_by then raise exception 'You asked to release this hold, so the cluster manager must decide it.'; end if;
 if p_action in ('withdraw','request_release') and p_actor <> r.raised_by then raise exception 'Only the person who raised this hold can do that.'; end if;
 if p_action in ('reject','reject_release','request_release') and (note is null or length(note) < 5) then raise exception 'Add a reason (at least 5 characters).'; end if;
 -- Approval places or lifts the real payout hold for the month, in the same transaction.
 if p_action in ('approve','approve_release') then
  -- Same rule as Payments: never change a hold while that month's payment is in bank processing.
  if exists (select 1 from workforce_payout_payment_items i where i.company_id = p_company and i.workforce_id = r.workforce_id
     and i.period_start = r.period_start and i.period_end = r.period_end and i.status = 'processing') then
   raise exception 'This month''s payment is in bank processing. Finance must cancel or finalise it before the hold changes.';
  end if;
  op := gen_random_uuid();
  result := workforce_set_payout_payment_hold(p_company, p_actor, op, r.workforce_id, r.period_start, r.period_end, p_action = 'approve',
   left(case when p_action = 'approve' then 'Team Ops hold: ' || r.reason else 'Team Ops release: ' || coalesce(note, r.release_request_note, 'approved') end, 1000));
 end if;
 update ops_workforce_hold_requests set status = target, version = version + 1, updated_at = now(),
  decided_by = case when p_action in ('approve','reject') then p_actor else decided_by end,
  decided_by_name = case when p_action in ('approve','reject') then p_name else decided_by_name end,
  decided_at = case when p_action in ('approve','reject') then now() else decided_at end,
  decision_note = case when p_action in ('approve','reject') then note else decision_note end,
  hold_operation_id = case when p_action = 'approve' then op else hold_operation_id end,
  release_requested_by = case when p_action = 'request_release' then p_actor when p_action = 'reject_release' then null else release_requested_by end,
  release_requested_at = case when p_action = 'request_release' then now() when p_action = 'reject_release' then null else release_requested_at end,
  release_request_note = case when p_action = 'request_release' then note when p_action = 'reject_release' then null else release_request_note end,
  released_by = case when p_action = 'approve_release' then p_actor else released_by end,
  released_by_name = case when p_action = 'approve_release' then p_name else released_by_name end,
  released_at = case when p_action = 'approve_release' then now() else released_at end,
  release_note = case when p_action = 'approve_release' then note else release_note end,
  release_operation_id = case when p_action = 'approve_release' then op else release_operation_id end
 where id = r.id returning * into saved;
 insert into ops_workforce_hold_events(company_id, request_id, action, from_status, to_status, actor_id, actor_name, note) values (p_company, r.id, p_action, r.status, target, p_actor, p_name, note);
 return saved;
end $$;

revoke all on function public.ops_workforce_hold_raise(uuid,uuid,date,text,uuid,text), public.ops_workforce_hold_transition(uuid,uuid,text,int,uuid,text,text) from public, anon, authenticated;
grant execute on function public.ops_workforce_hold_raise(uuid,uuid,date,text,uuid,text), public.ops_workforce_hold_transition(uuid,uuid,text,int,uuid,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
