-- Fleet Challan Recovery: a recovery ledger for challans that is fully SEPARATE from
-- the NL/SLP station-loss recovery (nl_loss_month_cases / nl_loss_recoveries).
--
-- Why: challan recoveries must not appear on, or flow into, the NL recovery screen.
-- This migration (1) creates dedicated challan-recovery tables, (2) rewrites
-- fleet_challan_open_recovery_v1 to write into them instead of nl_loss_month_cases,
-- and (3) migrates any challan rows already in nl_loss_month_cases out of it.
--
-- Payroll parity (cutoff / salary-hold / settled-credit / planned-vs-actual) is layered
-- on top of these tables by the app, reusing the same read-only payroll primitives the
-- NL screen uses, so the salary math never diverges. Apply alone to shared Supabase.

begin;

-- One recovery case per approved challan.
create table if not exists public.fleet_challan_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  challan_id uuid not null references public.fleet_challans(id) on delete cascade,
  challan_number text not null,
  vehicle_no text not null,
  station_code text not null,
  month text not null,                               -- offense salary/loss month YYYY-MM
  amount numeric(14,2) not null check (amount >= 0),
  status text not null default 'open'
    check (status in ('open','assigned','recovering','recovered','closed','cancelled')),
  offense_description text not null default '',
  evidence_url text not null default '',
  issuing_authority text not null default 'parivahan',
  approved_by uuid references public.profiles(id),
  approved_by_name text not null default '',
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, challan_id)
);
create index if not exists fleet_challan_recovery_cases_company_month
  on public.fleet_challan_recovery_cases(company_id, month, station_code);

-- Per-associate split / installment allocations for a case.
create table if not exists public.fleet_challan_recovery_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  case_id uuid not null references public.fleet_challan_recovery_cases(id) on delete cascade,
  person_ref text not null,
  person_name text not null default '',
  utr text not null default '',
  split_mode text not null default 'custom' check (split_mode in ('equal','custom')),
  amount numeric(14,2) not null check (amount >= 0),
  salary_month text not null,                        -- planned salary month YYYY-MM
  installment_no int not null default 1 check (installment_no >= 1),
  installment_count int not null default 1 check (installment_count >= 1),
  status text not null default 'planned'
    check (status in ('planned','posted','settled','waived','cancelled')),
  remarks text not null default '',
  updated_by uuid references public.profiles(id),
  updated_by_name text not null default '',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists fleet_challan_recovery_allocations_case
  on public.fleet_challan_recovery_allocations(company_id, case_id);
create index if not exists fleet_challan_recovery_allocations_person
  on public.fleet_challan_recovery_allocations(company_id, person_ref, salary_month);

-- Immutable audit of recovery changes.
create table if not exists public.fleet_challan_recovery_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  case_id uuid not null references public.fleet_challan_recovery_cases(id) on delete cascade,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  actor_id uuid references public.profiles(id),
  actor_name text not null default 'Fleet user',
  created_at timestamptz not null default now()
);
create index if not exists fleet_challan_recovery_events_case
  on public.fleet_challan_recovery_events(company_id, case_id, created_at desc);

alter table public.fleet_challan_recovery_cases enable row level security;
alter table public.fleet_challan_recovery_allocations enable row level security;
alter table public.fleet_challan_recovery_events enable row level security;
revoke all on public.fleet_challan_recovery_cases, public.fleet_challan_recovery_allocations,
  public.fleet_challan_recovery_events from anon, authenticated;
grant all on public.fleet_challan_recovery_cases, public.fleet_challan_recovery_allocations,
  public.fleet_challan_recovery_events to service_role;

-- Rewrite: open recovery into the SEPARATE challan ledger (no nl_loss_month_cases insert).
create or replace function public.fleet_challan_open_recovery_v1(
  p_company uuid, p_challan uuid, p_user uuid, p_name text, p_note text default null
) returns public.fleet_challans
language plpgsql
security invoker
set search_path = public
as $$
declare
  c public.fleet_challans;
  saved public.fleet_challans;
  v_month text;
  v_key text;
  v_case_id uuid;
  v_name text := coalesce(nullif(btrim(p_name),''),'Fleet user');
  note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  select * into c from public.fleet_challans where company_id = p_company and id = p_challan for update;
  if not found then raise exception 'Challan was not found.'; end if;
  if c.amount <= 0 then raise exception 'Challan amount must be greater than zero before recovery.'; end if;
  if c.status in ('cancelled','disposed','paid_external','recovered') then
    raise exception 'This challan is %, so recovery cannot be opened.', c.status;
  end if;

  v_month := to_char(coalesce(c.offense_date, (timezone('Asia/Kolkata', now()))::date), 'YYYY-MM');
  v_key := 'challan:' || c.challan_number;

  insert into public.fleet_challan_recovery_cases(
    company_id, challan_id, challan_number, vehicle_no, station_code, month, amount,
    status, offense_description, evidence_url, issuing_authority, approved_by, approved_by_name
  ) values (
    p_company, c.id, c.challan_number, c.vehicle_no, c.station_code, v_month, c.amount,
    'open', coalesce(nullif(c.offense_description,''),'Traffic challan'),
    coalesce(c.drive_view_url, c.evidence_url, ''), c.issuing_authority, p_user, v_name
  )
  on conflict (company_id, challan_id) do update
    set amount = excluded.amount,
        month = excluded.month,
        station_code = excluded.station_code,
        offense_description = excluded.offense_description,
        evidence_url = excluded.evidence_url,
        issuing_authority = excluded.issuing_authority,
        updated_at = now()
  returning id into v_case_id;

  update public.fleet_challans set
    status = case when status in ('recovering','recovered') then status else 'approved_for_recovery' end,
    recovery_month = v_month,
    recovery_case_key = v_key,
    reviewed_by = p_user,
    reviewed_at = now(),
    responsible_note = case when note is null then responsible_note else note end,
    updated_at = now()
  where id = c.id
  returning * into saved;

  insert into public.fleet_challan_recovery_events(company_id, case_id, action, after_value, actor_id, actor_name)
  values (p_company, v_case_id, 'open_recovery',
    jsonb_build_object('month', v_month, 'amount', c.amount, 'challan', c.challan_number, 'note', note),
    p_user, v_name);

  insert into public.fleet_challan_events(company_id, challan_id, action, from_status, to_status, actor_id, actor_name, note, metadata)
  values (
    p_company, c.id, 'open_recovery', c.status, saved.status, p_user, v_name, note,
    jsonb_build_object('recovery_month', v_month, 'recovery_case_key', v_key, 'ledger', 'fleet_challan')
  );
  return saved;
end;
$$;

revoke all on function public.fleet_challan_open_recovery_v1(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fleet_challan_open_recovery_v1(uuid, uuid, uuid, text, text) to service_role;

-- Migrate any challan rows already parked in the NL ledger into the new tables, then
-- remove them from NL so they no longer appear on or flow to the NL recovery screen.
insert into public.fleet_challan_recovery_cases(
  company_id, challan_id, challan_number, vehicle_no, station_code, month, amount,
  status, offense_description, evidence_url, issuing_authority, approved_by_name, approved_at
)
select
  fc.company_id, fc.id, fc.challan_number, fc.vehicle_no, fc.station_code,
  nlc.month, fc.amount, 'open',
  coalesce(nullif(fc.offense_description,''),'Traffic challan'),
  coalesce(fc.drive_view_url, fc.evidence_url, ''), fc.issuing_authority,
  coalesce(nlc.details->>'approved_by',''), nlc.last_seen_at
from public.nl_loss_month_cases nlc
join public.fleet_challans fc
  on fc.company_id = nlc.company_id and ('challan:' || fc.challan_number) = nlc.case_key
where nlc.source_file = 'fleet-challan' or nlc.case_key like 'challan:%'
on conflict (company_id, challan_id) do nothing;

-- Drop the migrated challan cases (and any orphan recoveries) from NL.
delete from public.nl_loss_recoveries r
  where r.case_key like 'challan:%'
    and exists (
      select 1 from public.nl_loss_month_cases c
      where c.company_id = r.company_id and c.month = r.month and c.case_key = r.case_key
        and (c.source_file = 'fleet-challan' or c.case_key like 'challan:%')
    );
delete from public.nl_loss_month_cases
  where source_file = 'fleet-challan' or case_key like 'challan:%';

notify pgrst, 'reload schema';
commit;
