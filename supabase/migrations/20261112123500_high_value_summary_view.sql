alter table public.report_bot_lm_dispatch_routes add column if not exists high_value_summary boolean not null default false;
notify pgrst,'reload schema';
