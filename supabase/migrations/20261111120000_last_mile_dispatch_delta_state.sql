begin;
alter table public.report_bot_lm_dispatch_runs
  add column if not exists snapshot jsonb;
comment on column public.report_bot_lm_dispatch_runs.snapshot is
  'Last successfully sent normalized report rows and as-of timestamp for Last Mile delta captions.';
notify pgrst, 'reload schema';
commit;
