begin;

-- Completion-based dark-store reminders remain pending after an intermediate
-- screenshot/text update and close only after the classifier returns pass.
alter table public.report_bot_report_types
  add column if not exists requires_pass_to_close boolean not null default false;

update public.report_bot_report_types
set requires_pass_to_close = true
where workspace = 'dark_store' and category = 'dark_store_completion';

commit;
