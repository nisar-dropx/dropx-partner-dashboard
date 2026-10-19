-- Replace one uploaded Flipkart half-month cycle atomically. The API parses and
-- validates the workbook first; this function keeps re-uploads authoritative
-- without exposing a delete/upsert gap to payout readers.

create or replace function public.replace_flipkart_production_cycle(
  p_company_id uuid,
  p_batch_id uuid,
  p_cycle_from date,
  p_cycle_to date,
  p_station_codes text[],
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  inserted_count integer := 0;
  expected_cycle_to date;
begin
  if p_company_id is null or p_batch_id is null then
    raise exception using errcode = '22023', message = 'Company and import batch are required.';
  end if;

  if p_cycle_from is null or p_cycle_to is null
     or date_trunc('month', p_cycle_from)::date <> date_trunc('month', p_cycle_to)::date
     or extract(day from p_cycle_from)::integer not in (1, 16) then
    raise exception using errcode = '22023', message = 'Flipkart uploads must cover one calendar half-month cycle.';
  end if;

  expected_cycle_to := case
    when extract(day from p_cycle_from)::integer = 1 then p_cycle_from + 14
    else (date_trunc('month', p_cycle_from) + interval '1 month - 1 day')::date
  end;
  if p_cycle_to <> expected_cycle_to then
    raise exception using errcode = '22023', message = 'Flipkart cycle end does not match the selected half-month.';
  end if;

  if not exists (
    select 1
    from public.report_import_batches batch
    where batch.id = p_batch_id
      and batch.company_id = p_company_id
      and batch.source_type = 'flipkart_production'
  ) then
    raise exception using errcode = '22023', message = 'Flipkart import batch does not belong to this company.';
  end if;

  if coalesce(cardinality(p_station_codes), 0) = 0
     or p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = '22023', message = 'The Flipkart cycle contains no production rows.';
  end if;

  if exists (
    select 1
    from unnest(p_station_codes) requested(station_code)
    where not exists (
      select 1
      from public.stations station
      join public.providers provider
        on provider.id = station.provider_id
       and provider.company_id = station.company_id
      where station.company_id = p_company_id
        and upper(trim(station.station_code)) = upper(trim(requested.station_code))
        and (lower(trim(provider.code)) = 'flipkart' or lower(trim(provider.name)) = 'flipkart')
    )
  ) then
    raise exception using errcode = '22023', message = 'The workbook contains a station that is not a permitted current or historical Flipkart location.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_data(
      work_date date,
      station_code text,
      provider_employee_id text,
      provider_employee_name text,
      shipment_type text,
      assigned_count numeric,
      total_delivery numeric,
      c_return numeric,
      total_activity numeric,
      del_rate numeric,
      c_return_rate numeric,
      mfn_rate numeric,
      mfn_return_rate numeric,
      mg_salary numeric,
      fuel_rate numeric,
      variable_pay numeric,
      mg_pay numeric,
      fuel_pay numeric,
      da_total_pay numeric,
      raw_row_count integer
    )
    where row_data.work_date not between p_cycle_from and p_cycle_to
       or nullif(trim(row_data.station_code), '') is null
       or nullif(trim(row_data.provider_employee_id), '') is null
       or upper(trim(row_data.station_code)) <> all(
         select upper(trim(station_code)) from unnest(p_station_codes) station_code
       )
       or coalesce(row_data.assigned_count, 0) < 0
       or coalesce(row_data.total_delivery, 0) < 0
       or coalesce(row_data.c_return, 0) < 0
       or coalesce(row_data.total_activity, 0) < 0
  ) then
    raise exception using errcode = '22023', message = 'The Flipkart cycle contains invalid production rows.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_data(work_date date, station_code text, provider_employee_id text)
    group by row_data.work_date, upper(trim(row_data.station_code)), upper(trim(row_data.provider_employee_id))
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'The Flipkart cycle contains duplicate daily provider totals.';
  end if;

  delete from public.cps_shipment_daily shipment
  where shipment.company_id = p_company_id
    and shipment.client = 'Flipkart'
    and shipment.work_date between p_cycle_from and p_cycle_to
    and upper(trim(shipment.station_code)) = any(
      select upper(trim(station_code)) from unnest(p_station_codes) station_code
    );

  insert into public.cps_shipment_daily (
    company_id,
    source_batch_id,
    client,
    work_date,
    station_code,
    provider_employee_id,
    provider_employee_name,
    shipment_type,
    amazon_delivery,
    swa_delivery,
    c_return,
    mfn,
    mfn_return,
    total_delivery,
    total_activity,
    pay_type,
    del_rate,
    c_return_rate,
    mfn_rate,
    mfn_return_rate,
    mg_salary,
    fuel_rate,
    variable_pay,
    mg_pay,
    fuel_pay,
    da_total_pay,
    assigned_count,
    raw_row_count,
    mapping_status,
    mapped_at,
    updated_at
  )
  select
    p_company_id,
    p_batch_id,
    'Flipkart',
    row_data.work_date,
    upper(trim(row_data.station_code)),
    trim(row_data.provider_employee_id),
    nullif(trim(row_data.provider_employee_name), ''),
    coalesce(nullif(trim(row_data.shipment_type), ''), 'Flipkart production'),
    0,
    0,
    coalesce(row_data.c_return, 0),
    0,
    0,
    coalesce(row_data.total_delivery, 0),
    coalesce(row_data.total_activity, 0),
    nullif(trim(row_data.pay_type), ''),
    coalesce(row_data.del_rate, 0),
    coalesce(row_data.c_return_rate, 0),
    coalesce(row_data.mfn_rate, 0),
    coalesce(row_data.mfn_return_rate, 0),
    coalesce(row_data.mg_salary, 0),
    coalesce(row_data.fuel_rate, 0),
    coalesce(row_data.variable_pay, 0),
    coalesce(row_data.mg_pay, 0),
    coalesce(row_data.fuel_pay, 0),
    coalesce(row_data.da_total_pay, 0),
    coalesce(row_data.assigned_count, 0),
    greatest(coalesce(row_data.raw_row_count, 0), 0),
    coalesce(nullif(trim(row_data.mapping_status), ''), 'Unmapped'),
    row_data.mapped_at,
    now()
  from jsonb_to_recordset(p_rows) as row_data(
    work_date date,
    station_code text,
    provider_employee_id text,
    provider_employee_name text,
    shipment_type text,
    assigned_count numeric,
    total_delivery numeric,
    c_return numeric,
    total_activity numeric,
    pay_type text,
    del_rate numeric,
    c_return_rate numeric,
    mfn_rate numeric,
    mfn_return_rate numeric,
    mg_salary numeric,
    fuel_rate numeric,
    variable_pay numeric,
    mg_pay numeric,
    fuel_pay numeric,
    da_total_pay numeric,
    mapping_status text,
    mapped_at timestamptz,
    raw_row_count integer
  );

  get diagnostics inserted_count = row_count;

  -- Keep the operational CPS summaries in the same transaction as the
  -- authoritative production replacement. Any refresh error rolls the whole
  -- import back, so a batch can never be reported failed after its facts were
  -- already committed or leave a delete/insert gap in the breakup table.
  delete from public.cps_cost_breakup_daily breakup
  where breakup.company_id = p_company_id
    and breakup.work_date between p_cycle_from and p_cycle_to
    and upper(trim(breakup.station_code)) = any(
      select upper(trim(station_code)) from unnest(p_station_codes) station_code
    );

  with scope as (
    select distinct
      upper(trim(requested.station_code)) as station_code,
      generated.work_date::date as work_date
    from unnest(p_station_codes) requested(station_code)
    cross join generate_series(p_cycle_from::timestamp, p_cycle_to::timestamp, interval '1 day') generated(work_date)
  ),
  shipment as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.total_delivery), 0) as total_delivery,
      coalesce(sum(fact.da_total_pay), 0) as mapped_da_pay
    from scope
    left join public.cps_shipment_daily fact
      on fact.company_id = p_company_id
     and fact.work_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  fuel as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.amount), 0) as fuel_cost
    from scope
    left join public.cps_fuel_daily fact
      on fact.company_id = p_company_id
     and fact.transaction_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  cashbook as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'DA Variable CPS'), 0) as cash_da_pay,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'UTR CPS'), 0) as staff_cost,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'VAN CPS'), 0) as vehicle_cost,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'Other CPS'), 0) as other_cost
    from scope
    left join public.cps_cashbook_daily fact
      on fact.company_id = p_company_id
     and fact.expense_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  breakup_source as (
    select
      shipment.station_code,
      shipment.work_date,
      shipment.total_delivery,
      cost.head,
      cost.sub_head,
      cost.source,
      cost.amount
    from shipment
    join fuel using (station_code, work_date)
    join cashbook using (station_code, work_date)
    cross join lateral (
      values
        ('DA Variable CPS'::text, 'Mapped DA payout'::text, 'Provider payroll mapping'::text, shipment.mapped_da_pay),
        ('DA Variable CPS'::text, 'Cashbook DA payout'::text, 'Cashbook'::text, cashbook.cash_da_pay),
        ('UTR CPS'::text, 'Staff / UTR payout'::text, 'Cashbook / Payroll'::text, cashbook.staff_cost),
        ('VAN CPS'::text, 'Fuel card spend'::text, 'Fuel import'::text, fuel.fuel_cost),
        ('VAN CPS'::text, 'Vehicle cashbook spend'::text, 'Cashbook'::text, cashbook.vehicle_cost),
        ('Other CPS'::text, 'Other operating expense'::text, 'Cashbook'::text, cashbook.other_cost)
    ) cost(head, sub_head, source, amount)
  )
  insert into public.cps_cost_breakup_daily (
    company_id,
    work_date,
    station_code,
    head,
    sub_head,
    source,
    amount,
    count,
    cps,
    notes
  )
  select
    p_company_id,
    work_date,
    station_code,
    head,
    sub_head,
    source,
    amount,
    total_delivery,
    case when total_delivery > 0 then amount / total_delivery else 0 end,
    null
  from breakup_source
  where amount <> 0 or total_delivery <> 0;

  with scope as (
    select distinct
      upper(trim(requested.station_code)) as station_code,
      generated.work_date::date as work_date
    from unnest(p_station_codes) requested(station_code)
    cross join generate_series(p_cycle_from::timestamp, p_cycle_to::timestamp, interval '1 day') generated(work_date)
  ),
  shipment as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.total_delivery), 0) as total_delivery,
      coalesce(sum(fact.total_activity), 0) as total_activity,
      coalesce(sum(fact.c_return), 0) as c_return,
      coalesce(sum(fact.mfn), 0) as mfn,
      coalesce(sum(fact.mfn_return), 0) as mfn_return,
      coalesce(sum(fact.da_total_pay), 0) as mapped_da_pay
    from scope
    left join public.cps_shipment_daily fact
      on fact.company_id = p_company_id
     and fact.work_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  fuel as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.amount), 0) as fuel_cost
    from scope
    left join public.cps_fuel_daily fact
      on fact.company_id = p_company_id
     and fact.transaction_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  cashbook as (
    select
      scope.station_code,
      scope.work_date,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'DA Variable CPS'), 0) as cash_da_pay,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'UTR CPS'), 0) as staff_cost,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'VAN CPS'), 0) as vehicle_cost,
      coalesce(sum(fact.amount) filter (where fact.cps_head = 'Other CPS'), 0) as other_cost
    from scope
    left join public.cps_cashbook_daily fact
      on fact.company_id = p_company_id
     and fact.expense_date = scope.work_date
     and upper(trim(fact.station_code)) = scope.station_code
    group by scope.station_code, scope.work_date
  ),
  metrics as (
    select
      shipment.*,
      fuel.fuel_cost,
      cashbook.cash_da_pay,
      cashbook.staff_cost,
      cashbook.vehicle_cost,
      cashbook.other_cost,
      shipment.mapped_da_pay + cashbook.cash_da_pay as da_pay_cost,
      fuel.fuel_cost + cashbook.vehicle_cost as van_cost,
      shipment.mapped_da_pay + cashbook.cash_da_pay + cashbook.staff_cost
        + fuel.fuel_cost + cashbook.vehicle_cost + cashbook.other_cost as total_cost,
      coalesce(target.target_cps, 0) as target_cps
    from shipment
    join fuel using (station_code, work_date)
    join cashbook using (station_code, work_date)
    left join lateral (
      select configured.target_cps
      from public.cps_station_targets configured
      where configured.company_id = p_company_id
        and upper(trim(configured.station_code)) = shipment.station_code
        and configured.is_active = true
        and configured.effective_from <= shipment.work_date
      order by configured.effective_from desc
      limit 1
    ) target on true
  )
  insert into public.cps_station_daily (
    company_id,
    work_date,
    station_code,
    total_delivery,
    total_activity,
    c_return,
    mfn,
    mfn_return,
    da_pay_cost,
    staff_cost,
    utr_cost,
    fuel_cost,
    vehicle_cost,
    van_cost,
    rent_cost,
    other_cost,
    total_cost,
    da_cps,
    staff_cps,
    fuel_cps,
    other_cps,
    overall_cps,
    target_cps,
    target_gap,
    target_impact,
    calculated_at,
    updated_at
  )
  select
    p_company_id,
    work_date,
    station_code,
    total_delivery,
    total_activity,
    c_return,
    mfn,
    mfn_return,
    da_pay_cost,
    staff_cost,
    staff_cost,
    fuel_cost,
    vehicle_cost,
    van_cost,
    0,
    other_cost,
    total_cost,
    case when total_delivery > 0 then da_pay_cost / total_delivery else 0 end,
    case when total_delivery > 0 then staff_cost / total_delivery else 0 end,
    case when total_delivery > 0 then van_cost / total_delivery else 0 end,
    case when total_delivery > 0 then other_cost / total_delivery else 0 end,
    case when total_delivery > 0 then total_cost / total_delivery else 0 end,
    target_cps,
    case when target_cps <> 0 and total_delivery > 0 then target_cps - (total_cost / total_delivery) else 0 end,
    case when target_cps <> 0 and total_delivery > 0 then (target_cps - (total_cost / total_delivery)) * total_delivery else 0 end,
    now(),
    now()
  from metrics
  on conflict (company_id, work_date, station_code) do update set
    total_delivery = excluded.total_delivery,
    total_activity = excluded.total_activity,
    c_return = excluded.c_return,
    mfn = excluded.mfn,
    mfn_return = excluded.mfn_return,
    da_pay_cost = excluded.da_pay_cost,
    staff_cost = excluded.staff_cost,
    utr_cost = excluded.utr_cost,
    fuel_cost = excluded.fuel_cost,
    vehicle_cost = excluded.vehicle_cost,
    van_cost = excluded.van_cost,
    rent_cost = excluded.rent_cost,
    other_cost = excluded.other_cost,
    total_cost = excluded.total_cost,
    da_cps = excluded.da_cps,
    staff_cps = excluded.staff_cps,
    fuel_cps = excluded.fuel_cps,
    other_cps = excluded.other_cps,
    overall_cps = excluded.overall_cps,
    target_cps = excluded.target_cps,
    target_gap = excluded.target_gap,
    target_impact = excluded.target_impact,
    calculated_at = excluded.calculated_at,
    updated_at = excluded.updated_at;

  return inserted_count;
end;
$function$;

revoke all on function public.replace_flipkart_production_cycle(uuid, uuid, date, date, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_flipkart_production_cycle(uuid, uuid, date, date, text[], jsonb)
  to service_role;

comment on function public.replace_flipkart_production_cycle(uuid, uuid, date, date, text[], jsonb) is
  'Atomically replaces permitted current or historical Flipkart stations for one 1-15 or 16-month-end production cycle and refreshes CPS summaries.';
