-- Durable vehicle availability history for lifecycle, calendar and downtime reporting.
create table if not exists public.fleet_vehicle_status_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vehicle_id uuid not null references public.fleet_vehicles(id) on delete cascade,
  vehicle_no text not null,
  status_key text not null,
  status_label text not null,
  status_reason_id uuid references public.fleet_vehicle_status_reason_master(id) on delete set null,
  status_reason_key text,
  status_reason_label text,
  comment text,
  expected_operational_date date,
  started_at timestamptz not null,
  ended_at timestamptz,
  changed_by uuid references public.profiles(id) on delete set null,
  source text not null default 'fleet',
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

create index if not exists fleet_vehicle_status_history_vehicle_idx
  on public.fleet_vehicle_status_history(company_id, vehicle_id, started_at desc);
create index if not exists fleet_vehicle_status_history_period_idx
  on public.fleet_vehicle_status_history(company_id, started_at, ended_at);
create unique index if not exists fleet_vehicle_status_history_open_idx
  on public.fleet_vehicle_status_history(company_id, vehicle_id)
  where ended_at is null;

alter table public.fleet_vehicle_status_history enable row level security;
revoke all on table public.fleet_vehicle_status_history from anon, authenticated;
grant select, insert, update, delete on table public.fleet_vehicle_status_history to service_role;

create or replace function public.capture_fleet_vehicle_status_history()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  change_at timestamptz := coalesce(new.status_updated_at, now());
  next_status_label text;
  next_reason_label text;
begin
  if tg_op = 'UPDATE' and not (
    old.status is distinct from new.status or
    old.status_reason_id is distinct from new.status_reason_id or
    old.status_reason_key is distinct from new.status_reason_key or
    old.status_comment is distinct from new.status_comment or
    old.non_operational_since is distinct from new.non_operational_since or
    old.expected_operational_date is distinct from new.expected_operational_date
  ) then
    return new;
  end if;

  select label into next_status_label
  from public.fleet_vehicle_status_master
  where company_id = new.company_id and status_key = new.status
  order by is_active desc, sort_order
  limit 1;

  if new.status_reason_id is not null then
    select label into next_reason_label
    from public.fleet_vehicle_status_reason_master
    where company_id = new.company_id and id = new.status_reason_id;
  end if;

  if tg_op = 'UPDATE' then
    update public.fleet_vehicle_status_history
    set ended_at = greatest(started_at, change_at)
    where company_id = new.company_id
      and vehicle_id = new.id
      and ended_at is null;
  end if;

  insert into public.fleet_vehicle_status_history (
    company_id, vehicle_id, vehicle_no, status_key, status_label,
    status_reason_id, status_reason_key, status_reason_label, comment,
    expected_operational_date, started_at, changed_by
  ) values (
    new.company_id, new.id, new.vehicle_no, new.status,
    coalesce(next_status_label, initcap(replace(new.status, '_', ' '))),
    new.status_reason_id, new.status_reason_key,
    coalesce(next_reason_label, nullif(initcap(replace(coalesce(new.status_reason_key, ''), '_', ' ')), '')),
    new.status_comment, new.expected_operational_date,
    case
      when tg_op = 'INSERT' then coalesce(new.non_operational_since::timestamptz, new.status_updated_at, new.created_at, now())
      else change_at
    end,
    new.status_updated_by
  );

  return new;
end;
$$;

drop trigger if exists fleet_vehicle_status_history_trigger on public.fleet_vehicles;
create trigger fleet_vehicle_status_history_trigger
after insert or update of status, status_reason_id, status_reason_key, status_comment, non_operational_since, expected_operational_date
on public.fleet_vehicles
for each row execute function public.capture_fleet_vehicle_status_history();

insert into public.fleet_vehicle_status_history (
  company_id, vehicle_id, vehicle_no, status_key, status_label,
  status_reason_id, status_reason_key, status_reason_label, comment,
  expected_operational_date, started_at, changed_by, source
)
select
  vehicle.company_id,
  vehicle.id,
  vehicle.vehicle_no,
  vehicle.status,
  coalesce(status.label, initcap(replace(vehicle.status, '_', ' '))),
  vehicle.status_reason_id,
  vehicle.status_reason_key,
  coalesce(reason.label, nullif(initcap(replace(coalesce(vehicle.status_reason_key, ''), '_', ' ')), '')),
  vehicle.status_comment,
  vehicle.expected_operational_date,
  case
    when coalesce(status.is_operational, vehicle.status = 'active') then coalesce(vehicle.status_updated_at, vehicle.created_at, now())
    else coalesce(vehicle.non_operational_since::timestamptz, vehicle.status_updated_at, vehicle.created_at, now())
  end,
  vehicle.status_updated_by,
  'backfill'
from public.fleet_vehicles vehicle
left join public.fleet_vehicle_status_master status
  on status.company_id = vehicle.company_id and status.status_key = vehicle.status and status.is_active
left join public.fleet_vehicle_status_reason_master reason
  on reason.company_id = vehicle.company_id and reason.id = vehicle.status_reason_id
where vehicle.company_id is not null
  and not exists (
    select 1 from public.fleet_vehicle_status_history history
    where history.company_id = vehicle.company_id
      and history.vehicle_id = vehicle.id
      and history.ended_at is null
  );

comment on table public.fleet_vehicle_status_history is
  'Effective-dated vehicle availability history used by lifecycle, calendar and downtime reports.';
