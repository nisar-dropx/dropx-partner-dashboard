begin;

-- Some groups are asked at fixed intervals all day, whether or not the report already
-- arrived. When false, a schedule posts at every reminder time; when true (the default,
-- and the old behaviour) reminders stop for the day once the report is received.
alter table public.report_bot_schedules
  add column if not exists stop_when_received boolean not null default true;

commit;
