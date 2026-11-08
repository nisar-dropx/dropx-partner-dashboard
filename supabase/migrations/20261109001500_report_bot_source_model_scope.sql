begin;

alter table public.report_bot_lm_dispatch_routes
  add column if not exists source_model_codes text[] not null default '{}'::text[];

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_source_models_check,
  add constraint report_bot_lm_dispatch_routes_source_models_check check (
    cardinality(source_model_codes) <= 25
    and '' <> all(source_model_codes)
  );

comment on column public.report_bot_lm_dispatch_routes.source_model_codes is
  'Optional location-model filter configured in Last Mile Report Bot master. Regional reports follow active People/location stations only when their model code is selected.';

notify pgrst,'reload schema';
commit;
