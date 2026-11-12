-- The column guard also supports clean replay before the older future-dated
-- high-value setup migration. Its ADD COLUMN IF NOT EXISTS preserves this limit.
alter table public.report_bot_lm_dispatch_routes
  add column if not exists high_value_threshold numeric not null default 3000;
alter table public.report_bot_lm_dispatch_routes
  alter column high_value_threshold set default 3000;
alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_high_value_threshold_check;
alter table public.report_bot_lm_dispatch_routes
  add constraint report_bot_lm_dispatch_routes_high_value_threshold_check check (high_value_threshold >= 3000);
