begin;
alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_report_check;
alter table public.report_bot_lm_dispatch_routes
  add constraint report_bot_lm_dispatch_routes_report_check
  check (report in (
    'edd', 'station', 'dsr', 'creturn', 'ageing', 'zero', 'oor', 'scrub',
    'cod', 'recon', 'deposit', 'bank', 'slip', 'eod'
  ));
comment on column public.report_bot_lm_dispatch_routes.report is
  'Last Mile outbound report key; oor is the dedicated Out-on-Road report requested by control tower.';
notify pgrst, 'reload schema';
commit;
