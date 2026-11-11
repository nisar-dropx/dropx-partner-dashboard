alter table public.report_bot_lm_dispatch_routes
  add column if not exists mention_latest_shift_designation_codes text[] not null default '{}'::text[];

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_latest_shift_designations_check;

alter table public.report_bot_lm_dispatch_routes
  add constraint report_bot_lm_dispatch_routes_latest_shift_designations_check
  check (
    cardinality(mention_latest_shift_designation_codes) <= 25
    and '' <> all (mention_latest_shift_designation_codes)
  );

comment on column public.report_bot_lm_dispatch_routes.mention_latest_shift_designation_codes is
  'Active People role codes tagged when currently present or part of the station latest biometric shift for the report day.';
