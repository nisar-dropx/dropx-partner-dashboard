alter table public.report_bot_lm_dispatch_routes
 add column if not exists high_value_min_days integer not null default 3 check (high_value_min_days between 1 and 90),
 add column if not exists high_value_escalation_time text not null default '23:00' check (high_value_escalation_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 add column if not exists high_value_escalation_roles text[] not null default array['HLM','SLPM'];
-- Existing routes remain disabled until the new sender has been verified.
