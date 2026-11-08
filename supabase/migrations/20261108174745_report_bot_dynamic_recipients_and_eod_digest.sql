alter table public.report_bot_lm_dispatch_routes
  add column if not exists mention_manager_policy text not null default 'none',
  add column if not exists mention_present_designation_codes text[] not null default '{}'::text[];

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_mention_manager_policy_check,
  add constraint report_bot_lm_dispatch_routes_mention_manager_policy_check
    check (mention_manager_policy in ('none', 'cluster_then_aom')),
  drop constraint if exists report_bot_lm_dispatch_routes_mention_present_designations_check,
  add constraint report_bot_lm_dispatch_routes_mention_present_designations_check
    check (
      cardinality(mention_present_designation_codes) <= 25
      and '' <> all (mention_present_designation_codes)
    );

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_report_check;

alter table public.report_bot_lm_dispatch_routes
  add constraint report_bot_lm_dispatch_routes_report_check
  check (report in (
    'edd', 'station', 'dsr', 'creturn', 'ageing', 'zero', 'scrub',
    'cod', 'recon', 'deposit', 'bank', 'slip', 'eod'
  ));

comment on column public.report_bot_lm_dispatch_routes.mention_manager_policy is
  'Configurable People manager tagging. cluster_then_aom always tags current CLM, or AOM only when no CLM exists.';

comment on column public.report_bot_lm_dispatch_routes.mention_present_designation_codes is
  'Current People designation codes to tag only while the person latest biometric punch is an open In at the source station.';
