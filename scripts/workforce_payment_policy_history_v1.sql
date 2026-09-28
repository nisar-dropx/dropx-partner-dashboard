begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- This ledger starts with an honest snapshot on the deployment date. It does
-- not infer policy for earlier dates from today's designation master.
create table if not exists public.workforce_payment_policy_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null references public.workforce(id) on delete restrict,
  station_id uuid references public.stations(id) on delete restrict,
  station_code_snapshot text,
  designation_id uuid references public.designations(id) on delete restrict,
  designation_code_snapshot text,
  designation_name_snapshot text,
  designation_is_active boolean not null,
  is_field_operations boolean not null,
  provider_mapping_required boolean not null,
  effective_from date not null,
  effective_to date,
  change_source text not null default 'trigger',
  recorded_at timestamptz not null default now(),
  constraint workforce_payment_policy_history_date_order_check
    check (effective_to is null or effective_to >= effective_from),
  constraint workforce_payment_policy_history_policy_check
    check (not provider_mapping_required or is_field_operations),
  constraint workforce_payment_policy_history_applicability_check
    check (designation_is_active or (not is_field_operations and not provider_mapping_required))
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.workforce_payment_policy_history'::regclass
      and conname='workforce_payment_policy_history_station_company_fk'
  ) then
    alter table public.workforce_payment_policy_history
      add constraint workforce_payment_policy_history_station_company_fk
      foreign key (company_id,station_id)
      references public.stations(company_id,id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.workforce_payment_policy_history'::regclass
      and conname='workforce_payment_policy_history_workforce_company_fk'
  ) then
    alter table public.workforce_payment_policy_history
      add constraint workforce_payment_policy_history_workforce_company_fk
      foreign key (company_id,workforce_id)
      references public.workforce(company_id,id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.workforce_payment_policy_history'::regclass
      and conname='workforce_payment_policy_history_designation_company_fk'
  ) then
    alter table public.workforce_payment_policy_history
      add constraint workforce_payment_policy_history_designation_company_fk
      foreign key (company_id,designation_id)
      references public.designations(company_id,id)
      on delete restrict;
  end if;
end
$$;

create unique index if not exists workforce_payment_policy_history_day_uidx
  on public.workforce_payment_policy_history(company_id,workforce_id,effective_from);
create index if not exists workforce_payment_policy_history_period_idx
  on public.workforce_payment_policy_history(company_id,workforce_id,effective_from desc,effective_to);
create index if not exists workforce_payment_policy_history_station_period_idx
  on public.workforce_payment_policy_history(company_id,station_id,effective_from desc,effective_to);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.workforce_payment_policy_history'::regclass
      and conname='workforce_payment_policy_history_no_overlap'
  ) then
    alter table public.workforce_payment_policy_history
      add constraint workforce_payment_policy_history_no_overlap
      exclude using gist (
        company_id with =,
        workforce_id with =,
        daterange(effective_from,coalesce(effective_to,'infinity'::date),'[]') with &&
      );
  end if;
end
$$;

comment on table public.workforce_payment_policy_history is
  'Effective-dated Workforce provider-mapping policy. History begins with the first truthful snapshot; no pre-ledger dates are inferred.';

alter table public.workforce_payment_policy_history enable row level security;
revoke all on public.workforce_payment_policy_history from public,anon,authenticated;
grant select on public.workforce_payment_policy_history to service_role;

create or replace function public.capture_workforce_payment_policy(
  p_workforce_id uuid,
  p_effective_from date default ((now() at time zone 'Asia/Kolkata')::date),
  p_designation_override uuid default null,
  p_change_source text default 'trigger'
)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_workforce public.workforce%rowtype;
  v_station public.stations%rowtype;
  v_designation public.designations%rowtype;
  v_current public.workforce_payment_policy_history%rowtype;
  v_next_from date;
  v_designation_is_active boolean := false;
  v_is_field_operations boolean := false;
  v_provider_mapping_required boolean := false;
begin
  if p_workforce_id is null or p_effective_from is null then
    raise exception 'Workforce and effective date are required for payment-policy history.';
  end if;

  select workforce.*
  into v_workforce
  from public.workforce workforce
  where workforce.id=p_workforce_id
  for update;

  if not found then
    return;
  end if;

  -- Workforce transitions lock this row before their own per-worker advisory
  -- lock. Preserve that global order here so direct capture cannot deadlock with
  -- a concurrent designation/location transition.
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-policy:'||p_workforce_id::text,0));

  select station.*
  into v_station
  from public.stations station
  where station.company_id=v_workforce.company_id
    and station.id=v_workforce.location_id;

  select designation.*
  into v_designation
  from public.designations designation
  where designation.company_id=v_workforce.company_id
    and (
      (p_designation_override is not null and designation.id=p_designation_override)
      or (
        p_designation_override is null
        and (
          designation.id=v_workforce.designation_id
          or (
            v_workforce.designation_id is null
            and lower(btrim(coalesce(v_workforce.designation,''))) in (
              lower(btrim(designation.code)),
              lower(btrim(designation.name))
            )
          )
        )
      )
    )
  order by (designation.id=v_workforce.designation_id) desc,designation.id
  limit 1;

  if found then
    v_designation_is_active:=coalesce(v_designation.is_active,false);
    v_is_field_operations:=v_designation_is_active and coalesce(v_designation.is_field_operations,false);
    v_provider_mapping_required:=v_is_field_operations and coalesce(v_designation.provider_mapping_required,false);
  end if;

  select policy.*
  into v_current
  from public.workforce_payment_policy_history policy
  where policy.company_id=v_workforce.company_id
    and policy.workforce_id=v_workforce.id
    and policy.effective_from<=p_effective_from
    and coalesce(policy.effective_to,p_effective_from)>=p_effective_from
  order by policy.effective_from desc,policy.recorded_at desc
  limit 1
  for update;

  if found
    and v_current.station_id is not distinct from v_station.id
    and v_current.station_code_snapshot is not distinct from v_station.station_code
    and v_current.designation_id is not distinct from v_designation.id
    and v_current.designation_code_snapshot is not distinct from v_designation.code
    and v_current.designation_name_snapshot is not distinct from v_designation.name
    and v_current.designation_is_active=v_designation_is_active
    and v_current.is_field_operations=v_is_field_operations
    and v_current.provider_mapping_required=v_provider_mapping_required then
    return;
  end if;

  if found and v_current.effective_from=p_effective_from then
    update public.workforce_payment_policy_history
    set station_id=v_station.id,
        station_code_snapshot=v_station.station_code,
        designation_id=v_designation.id,
        designation_code_snapshot=v_designation.code,
        designation_name_snapshot=v_designation.name,
        designation_is_active=v_designation_is_active,
        is_field_operations=v_is_field_operations,
        provider_mapping_required=v_provider_mapping_required,
        change_source=coalesce(nullif(btrim(p_change_source),''),'trigger'),
        recorded_at=now()
    where id=v_current.id;
    return;
  end if;

  if found then
    update public.workforce_payment_policy_history
    set effective_to=p_effective_from-1
    where id=v_current.id;
  end if;

  select min(policy.effective_from)
  into v_next_from
  from public.workforce_payment_policy_history policy
  where policy.company_id=v_workforce.company_id
    and policy.workforce_id=v_workforce.id
    and policy.effective_from>p_effective_from;

  insert into public.workforce_payment_policy_history(
    company_id,workforce_id,station_id,station_code_snapshot,
    designation_id,designation_code_snapshot,designation_name_snapshot,
    designation_is_active,is_field_operations,provider_mapping_required,
    effective_from,effective_to,change_source
  ) values (
    v_workforce.company_id,v_workforce.id,v_station.id,v_station.station_code,
    v_designation.id,v_designation.code,v_designation.name,
    v_designation_is_active,v_is_field_operations,v_provider_mapping_required,
    p_effective_from,case when v_next_from is null then null else v_next_from-1 end,
    coalesce(nullif(btrim(p_change_source),''),'trigger')
  )
  on conflict (company_id,workforce_id,effective_from) do update
  set station_id=excluded.station_id,
      station_code_snapshot=excluded.station_code_snapshot,
      designation_id=excluded.designation_id,
      designation_code_snapshot=excluded.designation_code_snapshot,
      designation_name_snapshot=excluded.designation_name_snapshot,
      designation_is_active=excluded.designation_is_active,
      is_field_operations=excluded.is_field_operations,
      provider_mapping_required=excluded.provider_mapping_required,
      effective_to=excluded.effective_to,
      change_source=excluded.change_source,
      recorded_at=now();
end
$$;

revoke all on function public.capture_workforce_payment_policy(uuid,date,uuid,text) from public,anon,authenticated;
grant execute on function public.capture_workforce_payment_policy(uuid,date,uuid,text) to service_role;

create or replace function public.capture_workforce_payment_policy_from_workforce()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  perform public.capture_workforce_payment_policy(
    new.id,
    (now() at time zone 'Asia/Kolkata')::date,
    new.designation_id,
    case when tg_op='INSERT' then 'workforce_insert' else 'workforce_assignment_change' end
  );
  return new;
end
$$;

drop trigger if exists workforce_payment_policy_history_insert on public.workforce;
create trigger workforce_payment_policy_history_insert
after insert on public.workforce
for each row execute function public.capture_workforce_payment_policy_from_workforce();

drop trigger if exists workforce_payment_policy_history_assignment on public.workforce;
drop trigger if exists workforce_payment_policy_history_designation on public.workforce;
create trigger workforce_payment_policy_history_assignment
after update of designation_id,designation,location_id on public.workforce
for each row
when (
  new.designation_id is distinct from old.designation_id
  or new.designation is distinct from old.designation
  or new.location_id is distinct from old.location_id
)
execute function public.capture_workforce_payment_policy_from_workforce();

create or replace function public.capture_workforce_payment_policy_from_designation()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_workforce record;
begin
  if tg_op='UPDATE'
    and new.code is not distinct from old.code
    and new.name is not distinct from old.name
    and new.is_active is not distinct from old.is_active
    and new.is_field_operations is not distinct from old.is_field_operations
    and new.provider_mapping_required is not distinct from old.provider_mapping_required then
    return new;
  end if;

  if tg_op='INSERT' then
    for v_workforce in
      select workforce.id
      from public.workforce workforce
      where workforce.company_id=new.company_id
        and (
          workforce.designation_id=new.id
          or (
            workforce.designation_id is null
            and lower(btrim(coalesce(workforce.designation,''))) in (lower(btrim(new.code)),lower(btrim(new.name)))
          )
        )
      order by workforce.id
    loop
      perform public.capture_workforce_payment_policy(v_workforce.id,(now() at time zone 'Asia/Kolkata')::date,new.id,'designation_master_insert');
    end loop;
  else
    for v_workforce in
      select workforce.id
      from public.workforce workforce
      where workforce.company_id=new.company_id
        and (
          workforce.designation_id=new.id
          or (
            workforce.designation_id is null
            and lower(btrim(coalesce(workforce.designation,''))) in (
              lower(btrim(new.code)),lower(btrim(new.name)),
              lower(btrim(old.code)),lower(btrim(old.name))
            )
          )
        )
      order by workforce.id
    loop
      perform public.capture_workforce_payment_policy(v_workforce.id,(now() at time zone 'Asia/Kolkata')::date,new.id,'designation_master_change');
    end loop;
  end if;

  return new;
end
$$;

drop trigger if exists designation_payment_policy_history_insert on public.designations;
create trigger designation_payment_policy_history_insert
after insert on public.designations
for each row execute function public.capture_workforce_payment_policy_from_designation();

drop trigger if exists designation_payment_policy_history_change on public.designations;
create trigger designation_payment_policy_history_change
after update of code,name,is_active,is_field_operations,provider_mapping_required on public.designations
for each row execute function public.capture_workforce_payment_policy_from_designation();

-- The only backfill is today's current state. Earlier dates intentionally remain
-- absent so CPS does not reinterpret old months using a modern designation.
do $$
declare
  v_workforce record;
  v_today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
  for v_workforce in
    select workforce.id
    from public.workforce workforce
    where not exists (
      select 1
      from public.workforce_payment_policy_history policy
      where policy.company_id=workforce.company_id
        and policy.workforce_id=workforce.id
        and policy.effective_from<=v_today
        and coalesce(policy.effective_to,v_today)>=v_today
    )
    order by workforce.company_id,workforce.id
  loop
    perform public.capture_workforce_payment_policy(v_workforce.id,v_today,null,'migration_backfill');
  end loop;
end
$$;

commit;
