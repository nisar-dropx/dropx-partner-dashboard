alter table public.report_bot_lm_dispatch_routes
  add column if not exists eod_sections text[] not null default array['dsr','dot','creturn']::text[];

alter table public.report_bot_lm_dispatch_routes
  drop constraint if exists report_bot_lm_dispatch_routes_eod_sections_check,
  add constraint report_bot_lm_dispatch_routes_eod_sections_check check (
    (report <> 'eod' or cardinality(eod_sections) between 1 and 3)
    and eod_sections <@ array['dsr','dot','creturn']::text[]
  );

comment on column public.report_bot_lm_dispatch_routes.eod_sections is
  'Configures which Final EOD images are sent by this route: DSR, DOT, and/or C-Return.';
