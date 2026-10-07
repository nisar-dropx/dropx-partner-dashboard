-- Preserve the rules that produced each saved day's exception flag.
-- Additive and backward-compatible: NULL means the legacy 22:00–05:00 policy.
alter table public.fleet_daily_km add column if not exists gps_policy jsonb;
comment on column public.fleet_daily_km.gps_policy is 'GPS operating-policy snapshot used at calculation. NULL is the legacy default; refresh explicitly recalculates with current policy.';
