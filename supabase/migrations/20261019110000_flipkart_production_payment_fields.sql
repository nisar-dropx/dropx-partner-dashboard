begin;

insert into public.report_import_master (
  company_id,
  source_code,
  name,
  description,
  file_types,
  day_offset,
  upload_time,
  frequency,
  weekday,
  parser_type,
  dedupe_fields,
  is_active,
  requires_station,
  station_scope,
  requires_report_date,
  report_date_label,
  date_default_offset
)
select
  company.id,
  'flipkart_production',
  'Flipkart Production',
  'Two Flipkart production uploads per month: 1-15 and 16-month-end. BP_RUNSHEET completed units are deliveries and BP_PICKUPSHEET completed units are customer returns.',
  array['xlsx', 'xls', 'csv']::text[],
  0,
  null::time,
  'monthly',
  null::smallint,
  'flipkart_production',
  array['sheet_id']::text[],
  true,
  false,
  'none',
  false,
  null,
  0
from public.companies company
where exists (
  select 1
  from public.providers provider
  where provider.company_id = company.id
    and (
      lower(btrim(coalesce(provider.code, ''))) = 'flipkart'
      or lower(btrim(coalesce(provider.name, ''))) = 'flipkart'
    )
)
on conflict (company_id, source_code) do update set
  name = excluded.name,
  description = excluded.description,
  file_types = excluded.file_types,
  day_offset = excluded.day_offset,
  upload_time = excluded.upload_time,
  frequency = excluded.frequency,
  weekday = excluded.weekday,
  parser_type = excluded.parser_type,
  dedupe_fields = excluded.dedupe_fields,
  is_active = excluded.is_active,
  requires_station = excluded.requires_station,
  station_scope = excluded.station_scope,
  requires_report_date = excluded.requires_report_date,
  report_date_label = excluded.report_date_label,
  date_default_offset = excluded.date_default_offset,
  updated_at = now();

with desired_metric(code, name, source_key, sort_order) as (
  values
    ('FLIPKART_DELIVERY', 'Flipkart Delivery', 'total_delivery', 10),
    ('FLIPKART_CUSTOMER_RETURN', 'Flipkart Customer Return', 'customer_return', 20)
)
insert into public.provider_production_metrics (
  company_id,
  provider_id,
  provider_model_id,
  code,
  name,
  source_key,
  source_keys,
  calculation_operation,
  sort_order,
  is_active
)
select
  provider.company_id,
  provider.id,
  null,
  desired_metric.code,
  desired_metric.name,
  desired_metric.source_key,
  array[desired_metric.source_key]::text[],
  'direct',
  desired_metric.sort_order,
  true
from public.providers provider
cross join desired_metric
where (
  lower(btrim(coalesce(provider.code, ''))) = 'flipkart'
  or lower(btrim(coalesce(provider.name, ''))) = 'flipkart'
)
and not exists (
  select 1
  from public.provider_production_metrics existing
  where existing.company_id = provider.company_id
    and existing.provider_id = provider.id
    and existing.provider_model_id is null
    and existing.source_key = desired_metric.source_key
)
on conflict do nothing;

with desired_metric(code, name, source_key, sort_order) as (
  values
    ('FLIPKART_DELIVERY', 'Flipkart Delivery', 'total_delivery', 10),
    ('FLIPKART_CUSTOMER_RETURN', 'Flipkart Customer Return', 'customer_return', 20)
)
update public.provider_production_metrics metric
set
  code = desired_metric.code,
  name = desired_metric.name,
  source_keys = array[desired_metric.source_key]::text[],
  calculation_operation = 'direct',
  sort_order = desired_metric.sort_order,
  is_active = true,
  updated_at = now()
from public.providers provider
cross join desired_metric
where metric.company_id = provider.company_id
  and metric.provider_id = provider.id
  and metric.provider_model_id is null
  and metric.source_key = desired_metric.source_key
  and (
    lower(btrim(coalesce(provider.code, ''))) = 'flipkart'
    or lower(btrim(coalesce(provider.name, ''))) = 'flipkart'
  );

with desired_selection as (
  select
    field.company_id,
    field.id as payment_field_id,
    provider.id as provider_id,
    model.id as provider_model_id,
    metric.id as provider_metric_id
  from public.payment_fields field
  join public.providers provider
    on provider.company_id = field.company_id
   and (
     lower(btrim(coalesce(provider.code, ''))) = 'flipkart'
     or lower(btrim(coalesce(provider.name, ''))) = 'flipkart'
   )
  join public.location_models model
    on model.company_id = provider.company_id
   and model.provider_id = provider.id
   and upper(btrim(model.code)) in ('MDH', 'ODH')
  join (
    values
      ('DELIVERY', 'total_delivery'),
      ('CRETURN', 'customer_return')
  ) as field_metric(field_code, source_key)
    on upper(btrim(field.code)) = field_metric.field_code
  join public.provider_production_metrics metric
    on metric.company_id = provider.company_id
   and metric.provider_id = provider.id
   and metric.provider_model_id is null
   and metric.source_key = field_metric.source_key
  where field.field_type = 'production'
    and field.is_active = true
)
update public.payment_field_provider_metrics selection
set
  provider_metric_id = desired_selection.provider_metric_id,
  updated_at = now()
from desired_selection
where selection.company_id = desired_selection.company_id
  and selection.payment_field_id = desired_selection.payment_field_id
  and selection.provider_id = desired_selection.provider_id
  and selection.provider_model_id = desired_selection.provider_model_id;

with desired_selection as (
  select
    field.company_id,
    field.id as payment_field_id,
    provider.id as provider_id,
    model.id as provider_model_id,
    metric.id as provider_metric_id
  from public.payment_fields field
  join public.providers provider
    on provider.company_id = field.company_id
   and (
     lower(btrim(coalesce(provider.code, ''))) = 'flipkart'
     or lower(btrim(coalesce(provider.name, ''))) = 'flipkart'
   )
  join public.location_models model
    on model.company_id = provider.company_id
   and model.provider_id = provider.id
   and upper(btrim(model.code)) in ('MDH', 'ODH')
  join (
    values
      ('DELIVERY', 'total_delivery'),
      ('CRETURN', 'customer_return')
  ) as field_metric(field_code, source_key)
    on upper(btrim(field.code)) = field_metric.field_code
  join public.provider_production_metrics metric
    on metric.company_id = provider.company_id
   and metric.provider_id = provider.id
   and metric.provider_model_id is null
   and metric.source_key = field_metric.source_key
  where field.field_type = 'production'
    and field.is_active = true
)
insert into public.payment_field_provider_metrics (
  company_id,
  payment_field_id,
  provider_id,
  provider_model_id,
  provider_metric_id
)
select
  desired_selection.company_id,
  desired_selection.payment_field_id,
  desired_selection.provider_id,
  desired_selection.provider_model_id,
  desired_selection.provider_metric_id
from desired_selection
where not exists (
  select 1
  from public.payment_field_provider_metrics existing
  where existing.company_id = desired_selection.company_id
    and existing.payment_field_id = desired_selection.payment_field_id
    and existing.provider_id = desired_selection.provider_id
    and existing.provider_model_id = desired_selection.provider_model_id
)
on conflict do nothing;

commit;
