-- Production counts belong to a provider and, when needed, one of its operating
-- models (EDSP, XPT, AMXL, and future models). Existing provider-level counts
-- remain valid as an "all models" fallback.
alter table public.provider_production_metrics
  add column if not exists provider_model_id uuid references public.location_models(id) on delete cascade,
  add column if not exists calculation_operation text not null default 'direct',
  add column if not exists source_keys text[] not null default '{}'::text[];

update public.provider_production_metrics
set source_keys = array[source_key]
where cardinality(source_keys) = 0 and nullif(trim(source_key), '') is not null;

alter table public.provider_production_metrics
  drop constraint if exists provider_production_metrics_company_id_provider_id_code_key,
  drop constraint if exists provider_production_metrics_company_id_provider_id_source_key_key;

alter table public.provider_production_metrics
  drop constraint if exists provider_production_metrics_calculation_operation_check;
alter table public.provider_production_metrics
  add constraint provider_production_metrics_calculation_operation_check
  check (calculation_operation in ('direct', 'sum'));

create unique index if not exists provider_production_metrics_scope_code_uidx
  on public.provider_production_metrics
  (company_id, provider_id, coalesce(provider_model_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

create index if not exists provider_production_metrics_model_lookup_idx
  on public.provider_production_metrics
  (company_id, provider_id, provider_model_id, is_active, sort_order);

alter table public.payment_field_provider_metrics
  add column if not exists provider_model_id uuid references public.location_models(id) on delete cascade;

alter table public.payment_field_provider_metrics
  drop constraint if exists payment_field_provider_metrics_company_id_payment_field_id_provider_id_key;

create unique index if not exists payment_field_provider_metrics_scope_uidx
  on public.payment_field_provider_metrics
  (company_id, payment_field_id, provider_id, coalesce(provider_model_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on column public.provider_production_metrics.provider_model_id is
  'Optional provider operating model. Null means this count is the provider-wide fallback.';
comment on column public.provider_production_metrics.source_keys is
  'Normalized imported data keys used by this count. Direct uses one; sum adds all selected keys.';
comment on column public.provider_production_metrics.calculation_operation is
  'Configuration-driven way to derive the production count from normalized imported data.';
