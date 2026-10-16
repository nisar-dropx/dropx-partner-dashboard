begin;

-- Reminders were tracked by position in the reminder-time list, so editing the times
-- mid-day (adding an earlier time) shifted every slot and skipped the wrong ones.
-- Track the last handled slot by its time of day instead (minutes since midnight).
alter table public.report_bot_requests
  add column if not exists last_reminder_minute integer check (last_reminder_minute is null or last_reminder_minute between 0 and 1439);

commit;
