create table public.finance_rent_master (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  site_code text not null check (site_code ~ '^[A-Z0-9_-]{1,40}$'),
  allocation_station_code text not null check (allocation_station_code ~ '^[A-Z0-9_-]{1,40}$'),
  parent_station_code text check (parent_station_code is null or parent_station_code ~ '^[A-Z0-9_-]{1,40}$'),
  region text,
  payee_name text not null check (length(btrim(payee_name)) between 1 and 160),
  monthly_rent numeric(14,2) not null check (monthly_rent >= 0),
  monthly_maintenance numeric(14,2) not null default 0 check (monthly_maintenance >= 0),
  effective_from date not null,
  effective_to date,
  change_reason text not null check (length(btrim(change_reason)) between 1 and 500),
  source_file text,
  source_sheet text,
  source_row integer,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (effective_to is null or effective_to >= effective_from)
);

create unique index finance_rent_master_current_key
  on public.finance_rent_master (
    company_id,
    site_code,
    lower(payee_name),
    effective_from
  )
  where deleted_at is null;

create index finance_rent_master_allocation_period
  on public.finance_rent_master (
    company_id,
    allocation_station_code,
    effective_from,
    effective_to
  )
  where deleted_at is null;

create table public.finance_rent_audit (
  id bigint generated always as identity primary key,
  rent_id uuid not null,
  company_id uuid not null,
  action text not null check (action in ('update','delete')),
  previous_record jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create index finance_rent_audit_lookup
  on public.finance_rent_audit(company_id, rent_id, changed_at desc);

alter table public.finance_rent_master enable row level security;
alter table public.finance_rent_audit enable row level security;
revoke all on table public.finance_rent_master from anon, authenticated;
revoke all on table public.finance_rent_audit from anon, authenticated;
grant select, insert, update on table public.finance_rent_master to service_role;
grant select, insert on table public.finance_rent_audit to service_role;

create function public.finance_rent_capture_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.finance_rent_audit(
    rent_id,
    company_id,
    action,
    previous_record,
    changed_by
  ) values (
    old.id,
    old.company_id,
    case when old.deleted_at is null and new.deleted_at is not null
      then 'delete' else 'update' end,
    to_jsonb(old),
    new.updated_by
  );
  return new;
end;
$$;

create trigger finance_rent_audit_changes
before update on public.finance_rent_master
for each row execute function public.finance_rent_capture_change();

revoke all on function public.finance_rent_capture_change()
  from public, anon, authenticated;

create function public.finance_save_rent(
  p_company uuid,
  p_actor uuid,
  p_item jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_id uuid;
  item_id uuid;
  item_from date;
  item_to date;
  item_rent numeric(14,2);
  item_maintenance numeric(14,2);
  changed integer;
begin
  if p_company is null or p_actor is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'Invalid rent record.';
  end if;

  item_id := nullif(p_item->>'id','')::uuid;
  item_from := (p_item->>'effective_from')::date;
  item_to := nullif(p_item->>'effective_to','')::date;
  item_rent := (p_item->>'monthly_rent')::numeric;
  item_maintenance := (p_item->>'monthly_maintenance')::numeric;

  if coalesce(p_item->>'site_code','') !~ '^[A-Z0-9_-]{1,40}$'
    or coalesce(p_item->>'allocation_station_code','') !~ '^[A-Z0-9_-]{1,40}$'
    or (nullif(p_item->>'parent_station_code','') is not null
      and (p_item->>'parent_station_code') !~ '^[A-Z0-9_-]{1,40}$')
    or length(btrim(coalesce(p_item->>'payee_name',''))) not between 1 and 160
    or item_rent < 0 or item_maintenance < 0
    or item_from is null or (item_to is not null and item_to < item_from)
    or length(btrim(coalesce(p_item->>'change_reason',''))) not between 1 and 500
  then
    raise exception 'Invalid rent fields.';
  end if;

  if not exists (
    select 1
    from public.stations s
    where s.company_id = p_company
      and s.station_code = p_item->>'allocation_station_code'
      and s.is_active
      and not coalesce(s.hide_from_location_list, false)
  ) then
    raise exception 'Rent must be allocated to an active Finance location.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('finance-rent:' || p_company::text, 0)
  );

  if item_id is null then
    insert into public.finance_rent_master(
      company_id,
      site_code,
      allocation_station_code,
      parent_station_code,
      region,
      payee_name,
      monthly_rent,
      monthly_maintenance,
      effective_from,
      effective_to,
      change_reason,
      source_file,
      source_sheet,
      source_row,
      created_by,
      updated_by
    ) values (
      p_company,
      p_item->>'site_code',
      p_item->>'allocation_station_code',
      nullif(p_item->>'parent_station_code',''),
      nullif(btrim(p_item->>'region'),''),
      btrim(p_item->>'payee_name'),
      item_rent,
      item_maintenance,
      item_from,
      item_to,
      btrim(p_item->>'change_reason'),
      coalesce(nullif(btrim(p_item->>'source_file'),''), 'Manual entry'),
      nullif(btrim(p_item->>'source_sheet'),''),
      nullif(p_item->>'source_row','')::integer,
      p_actor,
      p_actor
    ) returning id into saved_id;
  else
    update public.finance_rent_master r
    set site_code = p_item->>'site_code',
      allocation_station_code = p_item->>'allocation_station_code',
      parent_station_code = nullif(p_item->>'parent_station_code',''),
      region = nullif(btrim(p_item->>'region'),''),
      payee_name = btrim(p_item->>'payee_name'),
      monthly_rent = item_rent,
      monthly_maintenance = item_maintenance,
      effective_from = item_from,
      effective_to = item_to,
      change_reason = btrim(p_item->>'change_reason'),
      updated_by = p_actor,
      updated_at = now()
    where r.id = item_id
      and r.company_id = p_company
      and r.deleted_at is null
      and r.updated_at = (p_item->>'expected_updated_at')::timestamptz;
    get diagnostics changed = row_count;
    if changed <> 1 then
      raise exception 'Rent changed or was deleted. Refresh and review the latest record.';
    end if;
    saved_id := item_id;
  end if;

  return saved_id;
end;
$$;

create function public.finance_delete_rent(
  p_company uuid,
  p_actor uuid,
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare changed integer;
begin
  if p_company is null or p_actor is null or p_id is null
    or p_expected_updated_at is null
    or length(btrim(coalesce(p_reason,''))) not between 1 and 500
  then
    raise exception 'Invalid rent deletion.';
  end if;

  update public.finance_rent_master r
  set deleted_at = now(),
    updated_at = now(),
    updated_by = p_actor,
    change_reason = btrim(p_reason)
  where r.id = p_id
    and r.company_id = p_company
    and r.deleted_at is null
    and r.updated_at = p_expected_updated_at;
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'Rent changed or was deleted. Refresh and review the latest record.';
  end if;
  return true;
end;
$$;

revoke all on function public.finance_save_rent(uuid,uuid,jsonb)
  from public, anon, authenticated;
revoke all on function public.finance_delete_rent(uuid,uuid,uuid,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.finance_save_rent(uuid,uuid,jsonb)
  to service_role;
grant execute on function public.finance_delete_rent(uuid,uuid,uuid,timestamptz,text)
  to service_role;

-- One audited row per active agreement from RENT.xlsx / Rent. The workbook's
-- CLOSING rows and the Closed-Office / Closed-Acc sheets are intentionally absent.
with source(
  source_row, site_code, source_parent, region, payee_name,
  monthly_rent, monthly_maintenance
) as (values
  (2,'KGQA','KGQA','Kerala','Muhammed Navas',31500.00,0.00),
  (3,'TLPA','TLPA','Kerala','AJAI KUMAR KOROTH',19900.00,0.00),
  (4,'KTUB','KTUB','Kerala','SUMIJA K',25000.00,0.00),
  (5,'KLZH','KLZH','Kerala','Sobi Abraham',24000.00,0.00),
  (6,'KOZA','KOZA','Kerala','SUNIL K',75000.00,0.00),
  (7,'PEUA','PEUA','Kerala','KOMALAVALLY',18000.00,0.00),
  (8,'PMB','PMB','Kerala','ZUBAIR ILLATH',16030.00,0.00),
  (9,'CHM','CHM','Kerala','MUHAMMED M A',9500.00,0.00),
  (10,'JDBD','JDBD','Chhattisgarh','SUSHILA NAIK',31500.00,0.00),
  (11,'JGBA','JGBA','Chhattisgarh','ABHAY DAS',9300.00,0.00),
  (12,'JUGD','JUGD','Odisha','MINA YADAV',50000.00,0.00),
  (13,'JUGF','JUGD','Odisha','BAL GOPAL MISHRA',8000.00,0.00),
  (14,'SPBE','JUGD','Odisha','AMELENDU KUMAR SHARMA',5250.00,0.00),
  (15,'KANA','KANA','Odisha','ABHIMANYU PANIGRAHY',10000.00,0.00),
  (16,'KDJE','KDJE','Odisha','MOHAMMED EQBAL',25000.00,0.00),
  (17,'QLDA','QLDA','Kerala','Abdul Nazar TK',38000.00,0.00),
  (18,'GNTI','GNTI','Andhra Pradesh','GUMMADI JAYA KUMAR',20000.00,0.00),
  (19,'GNTI','GNTI','Andhra Pradesh','MYLAASEERWADAM',16500.00,0.00),
  (20,'XAPH','GDRD','Andhra Pradesh','MALIREDDI USHARANI',7500.00,0.00),
  (21,'GNTF','GNTF','Andhra Pradesh','RAVULA VENKATA RAO',16516.50,0.00),
  (22,'NLRC-SUB','NLRC','Andhra Pradesh','K.VASUNDHARA',4000.00,0.00),
  (23,'NLRE','NLRE','Andhra Pradesh','MANIKYAM VINOD KUMAR',15000.00,0.00),
  (24,'NLRE','NLRE','Andhra Pradesh','DHANA LAKSHMI DAMA',15000.00,0.00),
  (25,'NLRF','NLRF','Andhra Pradesh','MORLA SRAVAN',16474.00,0.00),
  (26,'NLRF','NLRF','Andhra Pradesh','RAJESWARI PARSA',16474.00,0.00),
  (27,'KDJG','KDJE','Odisha','JYOSNA SARDAR',2500.00,0.00),
  (28,'TIRC','TIRC','Andhra Pradesh','G LOKANADHA REDDY',18000.00,0.00),
  (29,'XAPI','GYMC','Andhra Pradesh','RACHETTI ASOKA KUMAR',7500.00,0.00),
  (30,'PHN','PHN','Odisha','DEEPAK KUMAR DAS',23625.00,600.00),
  (31,'KGQE','PEUA','Kerala','SAINABA SOOPPY P',10000.00,0.00),
  (32,'TLPB','TLPB','Kerala','SHAGINA PP',24000.00,0.00),
  (35,'KGQC','KGQA','Kerala','SAJITH PAKYARA MOHAMMED KUNHI HAJI',13000.00,0.00),
  (36,'XAPL','GNTI','Andhra Pradesh','KALYANI KALUVA',8000.00,0.00),
  (37,'GYMC','GYMC','Andhra Pradesh','P LATHA',47000.00,0.00),
  (38,'RPRN','RPRN','Chhattisgarh','CHETMANI NANDI',9000.00,0.00),
  (39,'SBPD','SBPD','Odisha','SUNIL KUMAR AGRAWAL',85000.00,0.00),
  (40,'JUGE','SBPD','Odisha','ASHOK KUMAR PATEL',5000.00,0.00),
  (41,'GDRD','GDRD','Andhra Pradesh','PULI INDRAVATHI',40000.00,0.00),
  (42,'MEP','MEP','Kerala','MUHAMMED NIHAL',8000.00,0.00),
  (43,'KTUO','KTUO','Kerala','ELDHOSE KV',45000.00,0.00),
  (44,'HBSC','HBSC','Odisha','RABIN CHANDRA SAHU',21000.00,0.00),
  (45,'SBPD-BURLA','SBPD','Odisha','ANSHUMAN BEHERA',15000.00,0.00),
  (46,'KTUR','KTUR','Kerala','YOUSAF AP',19000.00,0.00),
  (47,'TLPB-MAT','TLPB','Kerala','ASHOKAN VAZHAKATH',6000.00,0.00),
  (48,'KLZA-PAYYOLI','KLZA','Kerala','SHANMUGA PRIYA',30000.00,0.00),
  (49,'KTUB-EDK','KTUB','Kerala','JOHNSON VM',7000.00,0.00),
  (50,'SBPD-RENG','SBPD','Odisha','SUBASH CHANDRA PANDA',7500.00,0.00),
  (54,'NLRC','NLRC','Andhra Pradesh','THIRUGABATTINA SWATHI',20000.00,0.00),
  (55,'KLZA','KLZA','Kerala','RESHMI R',43000.00,0.00)
), finance_companies as (
  select distinct company_id
  from public.company_product_memberships
  where lower(product_code) = 'finance' and is_active
), prepared as (
  select
    c.company_id,
    src.*,
    case when exists (
      select 1 from public.stations s
      where s.company_id = c.company_id
        and s.station_code = src.site_code
        and s.is_active
        and not coalesce(s.hide_from_location_list, false)
    ) then src.site_code else src.source_parent end as allocation_station_code
  from finance_companies c cross join source src
)
insert into public.finance_rent_master(
  company_id,
  site_code,
  allocation_station_code,
  parent_station_code,
  region,
  payee_name,
  monthly_rent,
  monthly_maintenance,
  effective_from,
  change_reason,
  source_file,
  source_sheet,
  source_row
)
select
  company_id,
  site_code,
  allocation_station_code,
  nullif(source_parent, site_code),
  region,
  payee_name,
  monthly_rent,
  monthly_maintenance,
  date '2026-09-01',
  'Initial import from active Rent sheet; CLOSING and closed sheets excluded.',
  'RENT.xlsx',
  'Rent',
  source_row
from prepared
where exists (
  select 1 from public.stations s
  where s.company_id = prepared.company_id
    and s.station_code = prepared.allocation_station_code
    and s.is_active
    and not coalesce(s.hide_from_location_list, false)
)
on conflict do nothing;

create function public.finance_rent_adjusted_daily(
  p_company uuid,
  p_from date,
  p_through date,
  p_station_codes text[]
)
returns table(
  station_code text,
  work_date date,
  total numeric,
  missing_cost_rows bigint,
  da numeric,
  staff numeric,
  fuel numeric,
  vehicle numeric,
  rent numeric,
  other numeric,
  utr numeric,
  van numeric,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with rent_daily as (
    select
      r.allocation_station_code as station_code,
      d.work_date::date,
      sum(
        round(
          (r.monthly_rent + r.monthly_maintenance)
            * extract(day from d.work_date)::numeric
            / extract(day from (date_trunc('month', d.work_date)
              + interval '1 month - 1 day'))::numeric,
          2
        )
        - round(
          (r.monthly_rent + r.monthly_maintenance)
            * (extract(day from d.work_date)::numeric - 1)
            / extract(day from (date_trunc('month', d.work_date)
              + interval '1 month - 1 day'))::numeric,
          2
        )
      ) as rent,
      max(r.updated_at) as updated_at
    from public.finance_rent_master r
    join public.stations s
      on s.company_id = r.company_id
      and s.station_code = r.allocation_station_code
      and s.is_active
      and not coalesce(s.hide_from_location_list, false)
    cross join lateral generate_series(
      greatest(p_from, r.effective_from),
      least(p_through, coalesce(r.effective_to, p_through)),
      interval '1 day'
    ) d(work_date)
    where r.company_id = p_company
      and r.deleted_at is null
      and r.effective_from <= p_through
      and coalesce(r.effective_to, p_through) >= p_from
      and (
        p_station_codes is null
        or r.allocation_station_code = any(p_station_codes)
      )
    group by r.allocation_station_code, d.work_date
  ), base as (
    select
      station_code,
      work_date,
      sum(total_cost) as total,
      count(*) filter (where total_cost is null) as missing_cost_rows,
      sum(da_pay_cost) as da,
      sum(staff_cost) as staff,
      sum(fuel_cost) as fuel,
      sum(vehicle_cost) as vehicle,
      sum(rent_cost) as imported_rent,
      sum(other_cost) as other,
      sum(utr_cost) as utr,
      sum(van_cost) as van,
      max(updated_at) as updated_at
    from public.cps_station_daily
    where company_id = p_company
      and work_date between p_from and p_through
      and (p_station_codes is null or station_code = any(p_station_codes))
    group by station_code, work_date
  )
  select
    coalesce(b.station_code, r.station_code) as station_code,
    coalesce(b.work_date, r.work_date) as work_date,
    case
      when b.station_code is null then r.rent
      when b.total is null then r.rent
      when r.rent is null then b.total
      else b.total - coalesce(b.imported_rent, 0) + r.rent
    end as total,
    case
      when b.station_code is null then 1
      else b.missing_cost_rows
    end as missing_cost_rows,
    b.da,
    b.staff,
    b.fuel,
    b.vehicle,
    coalesce(r.rent, b.imported_rent) as rent,
    b.other,
    b.utr,
    b.van,
    greatest(b.updated_at, r.updated_at) as updated_at
  from base b
  full outer join rent_daily r
    on r.station_code = b.station_code and r.work_date = b.work_date;
$$;

revoke all on function public.finance_rent_adjusted_daily(uuid,date,date,text[])
  from public, anon, authenticated;
grant execute on function public.finance_rent_adjusted_daily(uuid,date,date,text[])
  to service_role;

create or replace function public.finance_business_snapshot(
  p_company uuid,
  p_from date,
  p_through date,
  p_station_codes text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_company is null or p_from is null or p_through is null
    or extract(day from p_from) <> 1
    or p_through < p_from or date_trunc('month',p_through) <> p_from
    or p_through > (now() at time zone 'Asia/Kolkata')::date
  then
    raise exception 'Choose a billing month and a through date no later than today.';
  end if;

  return jsonb_build_object(
    'shipments', coalesce((
      select jsonb_agg(to_jsonb(s)) from (
        select
          station_code,
          client,
          count(distinct work_date) as days,
          min(work_date) as first_date,
          max(work_date) as last_date,
          sum(total_delivery)::text as deliveries,
          sum(mfn)::text as mfn,
          sum(c_return)::text as returns,
          count(*) filter(where total_delivery is null) as missing_delivery_rows,
          max(updated_at) as updated_at
        from public.cps_shipment_daily
        where company_id = p_company
          and work_date between p_from and p_through
          and (p_station_codes is null or station_code = any(p_station_codes))
        group by station_code, client
      ) s
    ), '[]'::jsonb),
    'costs', coalesce((
      select jsonb_agg(to_jsonb(c)) from (
        select
          station_code,
          count(*) as days,
          min(work_date) as first_date,
          max(work_date) as last_date,
          sum(missing_cost_rows) as missing_cost_rows,
          sum(total)::text as total,
          sum(da)::text as da,
          sum(staff)::text as staff,
          sum(fuel)::text as fuel,
          sum(vehicle)::text as vehicle,
          sum(rent)::text as rent,
          sum(other)::text as other,
          sum(utr)::text as utr,
          sum(van)::text as van,
          max(updated_at) as updated_at
        from public.finance_rent_adjusted_daily(
          p_company, p_from, p_through, p_station_codes
        )
        group by station_code
      ) c
    ), '[]'::jsonb),
    'read_at', now()
  );
end;
$$;

revoke all on function public.finance_business_snapshot(uuid,date,date,text[])
  from public, anon, authenticated;
grant execute on function public.finance_business_snapshot(uuid,date,date,text[])
  to service_role;

-- Recreate only the daily cost portion; daily shipment detail stays unchanged
-- and is appended by the previously deployed function body below this migration.
create or replace function public.finance_business_daily_snapshot(
  p_company uuid,
  p_from date,
  p_through date,
  p_station_codes text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare result jsonb;
begin
  result := public.finance_business_snapshot(
    p_company, p_from, p_through, p_station_codes
  );

  return result || jsonb_build_object(
    'daily_shipments',
    coalesce((
      with current_source as materialized (
        select
          id, source_batch_id, station_code, work_date,
          provider_employee_id, client, total_delivery, amazon_delivery,
          swa_delivery, c_return, mfn, updated_at
        from public.cps_shipment_daily
        where company_id = p_company
          and work_date between p_from and p_through
          and (p_station_codes is null or station_code = any(p_station_codes))
      ), active_days as materialized (
        select distinct source_batch_id, station_code, work_date
        from current_source where lower(client) = 'amazon'
      ), active_audit as materialized (
        select
          r.id, r.batch_id, r.station_code, r.work_date,
          r.external_worker_id, r.row_number, r.normalized_data, r.raw_data
        from active_days a
        join public.report_import_rows r
          on r.company_id = p_company
          and r.source_type = 'amazon_shipments'
          and r.batch_id = a.source_batch_id
          and r.station_code = a.station_code
          and r.work_date = a.work_date
          and r.normalized_data is not null
      ), audit_grain as (
        select distinct on (
          c.id, lower(coalesce(r.normalized_data->>'shipment_type', ''))
        )
          c.id as source_id, r.normalized_data, r.raw_data
        from current_source c
        join active_audit r
          on r.batch_id = c.source_batch_id
          and r.station_code = c.station_code
          and r.work_date = c.work_date
          and r.external_worker_id = c.provider_employee_id
          and r.normalized_data is not null
        where lower(c.client) = 'amazon'
        order by
          c.id,
          lower(coalesce(r.normalized_data->>'shipment_type', '')),
          r.row_number,
          r.id
      ), metrics as materialized (
        select
          source_id,
          public.finance_report_count(
            normalized_data, raw_data, 'smd_delivery',
            array['overalldeliveredsmd']
          ) as smd,
          public.finance_report_count(
            normalized_data, raw_data, 'smd2_delivery',
            array['overalldeliveredsmd2', 'overalldeliveredsmd20']
          ) as smd2,
          public.finance_report_count(
            normalized_data, raw_data, 'ihs',
            array['finalihshandled']
          ) as ihs
        from audit_grain
      ), audit as (
        select
          source_id,
          case when count(*) filter (where smd is null or smd2 is null) = 0
            then sum(smd + smd2) end as smd,
          case when count(*) filter (where ihs is null) = 0
            then sum(ihs) end as ihs
        from metrics group by source_id
      )
      select jsonb_agg(to_jsonb(d) order by d.station_code, d.client, d.work_date)
      from (
        select
          c.station_code,
          c.client,
          c.work_date,
          case when count(*) filter (where c.total_delivery is null) = 0
            then sum(c.total_delivery)::text end as deliveries,
          case when count(*) filter (where c.amazon_delivery is null) = 0
            then sum(c.amazon_delivery)::text end as mg_deliveries,
          case when count(*) filter (where c.swa_delivery is null) = 0
            then sum(c.swa_delivery)::text end as swa,
          case when count(*) filter (where c.c_return is null) = 0
            then sum(c.c_return)::text end as returns,
          case when count(*) filter (where c.mfn is null) = 0
            then sum(c.mfn)::text end as mfn,
          case when count(*) filter (where a.smd is null or a.smd > c.total_delivery) = 0
            then sum(a.smd)::text end as smd,
          case when count(*) filter (where a.ihs is null) = 0
            then sum(a.ihs)::text end as ihs,
          count(*) filter (where a.smd is null or a.ihs is null)
            as missing_breakdown_rows,
          max(c.updated_at) as updated_at
        from current_source c
        left join audit a on a.source_id = c.id
        group by c.station_code, c.client, c.work_date
      ) d
    ), '[]'::jsonb),
    'daily_costs',
    coalesce((
      select jsonb_agg(to_jsonb(c) order by c.station_code, c.work_date)
      from (
        select
          station_code,
          work_date,
          total::text,
          rent::text,
          missing_cost_rows,
          updated_at
        from public.finance_rent_adjusted_daily(
          p_company, p_from, p_through, p_station_codes
        )
      ) c
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.finance_business_daily_snapshot(
  uuid,date,date,text[]
) from public, anon, authenticated;
grant execute on function public.finance_business_daily_snapshot(
  uuid,date,date,text[]
) to service_role;

insert into public.app_pages(company_id,code,name,sort_order,is_active)
select distinct m.company_id, 'finance_rent', 'Rent Master', 111, true
from public.company_product_memberships m
where lower(m.product_code) = 'finance'
on conflict(company_id,code) do update
set name = excluded.name, sort_order = excluded.sort_order, is_active = true;

update public.app_pages
set sort_order = case code
  when 'finance_revenue' then 112
  when 'finance_pnl' then 113
end
where code in ('finance_revenue','finance_pnl')
  and company_id in (
    select company_id from public.company_product_memberships
    where lower(product_code) = 'finance'
  );

insert into public.role_page_permissions(
  company_id, role_id, page_id, can_view, can_add, can_edit
)
select
  source.company_id,
  source.role_id,
  target.id,
  source.can_view,
  source.can_add,
  source.can_edit
from public.role_page_permissions source
join public.app_pages pricing
  on pricing.id = source.page_id
  and pricing.company_id = source.company_id
  and pricing.code = 'finance_pricing'
join public.app_pages target
  on target.company_id = source.company_id
  and target.code = 'finance_rent'
on conflict(company_id,role_id,page_id) do nothing;
