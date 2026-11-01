-- Configurable Workforce incentive plans and auditable Flipkart conversion inputs.
-- Conversion uses BP_RUNSHEET completed / BP_RUNSHEET assigned. Pickup sheets
-- remain separately auditable and never dilute the delivery conversion rate.

alter table public.cps_shipment_daily
  add column if not exists delivery_assigned_count numeric not null default 0,
  add column if not exists pickup_assigned_count numeric not null default 0;

alter table public.cps_shipment_daily
  drop constraint if exists cps_shipment_daily_delivery_assigned_nonnegative,
  drop constraint if exists cps_shipment_daily_pickup_assigned_nonnegative;

alter table public.cps_shipment_daily
  add constraint cps_shipment_daily_delivery_assigned_nonnegative check (delivery_assigned_count >= 0),
  add constraint cps_shipment_daily_pickup_assigned_nonnegative check (pickup_assigned_count >= 0);

-- Backfill every still-authoritative Flipkart fact from its immutable import
-- audit. Superseded batches are harmless because facts match source_batch_id.
with source_counts as (
  select
    source.batch_id,
    source.work_date,
    upper(trim(source.station_code)) as station_code,
    upper(trim(source.external_worker_id)) as provider_employee_id,
    sum(coalesce((source.normalized_data ->> 'assigned_count')::numeric, 0))
      filter (where upper(source.normalized_data ->> 'sheet_type') = 'BP_RUNSHEET') as delivery_assigned_count,
    sum(coalesce((source.normalized_data ->> 'assigned_count')::numeric, 0))
      filter (where upper(source.normalized_data ->> 'sheet_type') = 'BP_PICKUPSHEET') as pickup_assigned_count
  from public.report_import_rows source
  where source.source_type = 'flipkart_production'
    and source.status = 'Imported'
    and source.batch_id is not null
    and source.work_date is not null
    and nullif(trim(source.station_code), '') is not null
    and nullif(trim(source.external_worker_id), '') is not null
  group by source.batch_id, source.work_date, upper(trim(source.station_code)), upper(trim(source.external_worker_id))
)
update public.cps_shipment_daily fact
set
  delivery_assigned_count = coalesce(source_counts.delivery_assigned_count, 0),
  pickup_assigned_count = coalesce(source_counts.pickup_assigned_count, 0),
  assigned_count = coalesce(source_counts.delivery_assigned_count, 0) + coalesce(source_counts.pickup_assigned_count, 0),
  updated_at = now()
from source_counts
where fact.source_batch_id = source_counts.batch_id
  and fact.client = 'Flipkart'
  and fact.work_date = source_counts.work_date
  and upper(trim(fact.station_code)) = source_counts.station_code
  and upper(trim(fact.provider_employee_id)) = source_counts.provider_employee_id;

create or replace function public.apply_flipkart_assigned_count_split(
  p_company_id uuid,
  p_batch_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  updated_count integer := 0;
  expected_count integer := 0;
begin
  if p_company_id is null or p_batch_id is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = '22023', message = 'Company, batch, and Flipkart production rows are required.';
  end if;

  if not exists (
    select 1 from public.report_import_batches batch
    where batch.id = p_batch_id
      and batch.company_id = p_company_id
      and batch.source_type = 'flipkart_production'
  ) then
    raise exception using errcode = '22023', message = 'Flipkart import batch does not belong to this company.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_data(
      work_date date,
      station_code text,
      provider_employee_id text,
      delivery_assigned_count numeric,
      pickup_assigned_count numeric,
      total_delivery numeric,
      c_return numeric
    )
    where row_data.work_date is null
       or nullif(trim(row_data.station_code), '') is null
       or nullif(trim(row_data.provider_employee_id), '') is null
       or coalesce(row_data.delivery_assigned_count, -1) < 0
       or coalesce(row_data.pickup_assigned_count, -1) < 0
       or coalesce(row_data.total_delivery, 0) > coalesce(row_data.delivery_assigned_count, -1)
       or coalesce(row_data.c_return, 0) > coalesce(row_data.pickup_assigned_count, -1)
  ) then
    raise exception using errcode = '22023', message = 'Flipkart assigned and completed counts do not reconcile.';
  end if;

  expected_count := jsonb_array_length(p_rows);

  update public.cps_shipment_daily fact
  set
    delivery_assigned_count = row_data.delivery_assigned_count,
    pickup_assigned_count = row_data.pickup_assigned_count,
    assigned_count = row_data.delivery_assigned_count + row_data.pickup_assigned_count,
    updated_at = now()
  from jsonb_to_recordset(p_rows) as row_data(
    work_date date,
    station_code text,
    provider_employee_id text,
    delivery_assigned_count numeric,
    pickup_assigned_count numeric
  )
  where fact.company_id = p_company_id
    and fact.source_batch_id = p_batch_id
    and fact.client = 'Flipkart'
    and fact.work_date = row_data.work_date
    and upper(trim(fact.station_code)) = upper(trim(row_data.station_code))
    and upper(trim(fact.provider_employee_id)) = upper(trim(row_data.provider_employee_id));

  get diagnostics updated_count = row_count;
  if updated_count <> expected_count then
    raise exception using errcode = 'P0001', message = 'Not every Flipkart production row received its assignment split.';
  end if;
  return updated_count;
end;
$function$;

revoke all on function public.apply_flipkart_assigned_count_split(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_flipkart_assigned_count_split(uuid, uuid, jsonb)
  to service_role;

alter table public.workforce_incentive_campaigns
  add column if not exists incentive_type text not null default 'performance',
  add column if not exists cycle_type text not null default 'daily',
  add column if not exists location_model_id uuid references public.location_models(id) on delete restrict,
  add column if not exists minimum_activity numeric not null default 0,
  add column if not exists tiers jsonb not null default '[]'::jsonb;

alter table public.workforce_incentive_campaigns
  drop constraint if exists workforce_incentive_metric_check,
  drop constraint if exists workforce_incentive_calculation_check,
  drop constraint if exists workforce_incentive_reward_check,
  drop constraint if exists workforce_incentive_type_check,
  drop constraint if exists workforce_incentive_cycle_check,
  drop constraint if exists workforce_incentive_minimum_activity_check,
  drop constraint if exists workforce_incentive_tiers_check;

alter table public.workforce_incentive_campaigns
  add constraint workforce_incentive_type_check
    check (incentive_type in ('conversion', 'performance')),
  add constraint workforce_incentive_cycle_check
    check (cycle_type in ('daily', 'half_monthly', 'monthly')),
  add constraint workforce_incentive_metric_check
    check (metric in ('delivery_conversion', 'total_delivery', 'total_activity', 'amazon_delivery', 'swa_delivery', 'c_return', 'mfn')),
  add constraint workforce_incentive_calculation_check
    check (calculation_type in ('per_unit_above_threshold', 'flat_threshold', 'tiered_flat')),
  add constraint workforce_incentive_minimum_activity_check
    check (minimum_activity >= 0),
  add constraint workforce_incentive_tiers_check
    check (jsonb_typeof(tiers) = 'array'),
  add constraint workforce_incentive_reward_check
    check (
      (calculation_type = 'flat_threshold' and flat_amount > 0)
      or (calculation_type = 'per_unit_above_threshold' and rate_value > 0)
      or (calculation_type = 'tiered_flat' and jsonb_array_length(tiers) > 0)
    );

create index if not exists workforce_incentive_campaigns_model_idx
  on public.workforce_incentive_campaigns(company_id, location_model_id)
  where location_model_id is not null;

comment on column public.workforce_incentive_campaigns.tiers is
  'Ordered incentive slabs as [{"minimum": numeric, "amount": numeric}]. The application validates ascending non-overlapping values.';
comment on column public.workforce_incentive_campaigns.minimum_activity is
  'Minimum denominator/activity required before a cycle can earn an incentive.';
