begin;
alter table public.report_bot_lm_dispatch_routes add column if not exists dsr_pace jsonb not null default '[]'::jsonb;
alter table public.report_bot_lm_dispatch_routes add column if not exists high_value_threshold numeric not null default 5000 check(high_value_threshold>=5000);
alter table public.report_bot_lm_dispatch_routes drop constraint if exists report_bot_lm_dispatch_routes_report_check;
alter table public.report_bot_lm_dispatch_routes add constraint report_bot_lm_dispatch_routes_report_check check(report in ('edd','station','dsr','creturn','ageing','zero','oor','scrub','cod','recon','deposit','bank','slip','eod','high_value'));
update public.report_bot_lm_dispatch_routes set dsr_pace='[{"time":"08:00","target":0},{"time":"10:30","target":25},{"time":"12:00","target":40},{"time":"14:00","target":55},{"time":"16:00","target":70},{"time":"18:00","target":85},{"time":"20:00","target":95},{"time":"22:00","target":98}]'::jsonb where report='dsr' and dsr_pace='[]'::jsonb;
notify pgrst,'reload schema';
commit;
