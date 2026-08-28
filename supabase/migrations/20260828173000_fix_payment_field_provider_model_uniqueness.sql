alter table public.payment_field_provider_metrics
  drop constraint if exists payment_field_provider_metric_company_id_payment_field_id_p_key;

create unique index if not exists payment_field_provider_metrics_model_scope_uidx
  on public.payment_field_provider_metrics (company_id, payment_field_id, provider_id, provider_model_id)
  where provider_model_id is not null;

create unique index if not exists payment_field_provider_metrics_default_scope_uidx
  on public.payment_field_provider_metrics (company_id, payment_field_id, provider_id)
  where provider_model_id is null;
