begin;

-- Route-owned role tags let Operations configure Control Tower or leadership
-- recipients without embedding people, phone numbers, stations or reports in code.
alter table public.report_bot_lm_dispatch_routes
  add column if not exists mention_designation_codes text[] not null default '{}';

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_mention_designation_codes_check,
  add constraint report_bot_lm_dispatch_routes_mention_designation_codes_check
    check (cardinality(mention_designation_codes) <= 25);

notify pgrst, 'reload schema';
commit;
