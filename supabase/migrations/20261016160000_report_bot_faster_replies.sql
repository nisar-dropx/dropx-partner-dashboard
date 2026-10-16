begin;

-- Replies were taking minutes: a 20-90 second "natural" delay plus a 30 second
-- per-group gap on top of the minute cron. Shorter defaults, and rows still on the
-- untouched old defaults move to them; deliberate choices are kept.
alter table public.report_bot_settings alter column reply_delay_min_seconds set default 3;
alter table public.report_bot_settings alter column reply_delay_max_seconds set default 10;
alter table public.report_bot_settings alter column group_min_gap_seconds set default 10;

update public.report_bot_settings
set reply_delay_min_seconds = 3, reply_delay_max_seconds = 10, updated_at = now()
where reply_delay_min_seconds = 20 and reply_delay_max_seconds = 90;

update public.report_bot_settings
set group_min_gap_seconds = 10, updated_at = now()
where group_min_gap_seconds = 30;

-- Replies now carry the review itself ({checks}: failed and unclear rules with the
-- reason) and tag the sender with an @mention ({sender}).
alter table public.report_bot_settings
  alter column feedback_template set default E'{sender} *{report}*\n{verdict_label}\n{feedback}\n{checks}';

update public.report_bot_settings
set feedback_template = E'{sender} *{report}*\n{verdict_label}\n{feedback}\n{checks}', updated_at = now()
where feedback_template = E'*{report}* · {sender}\n{verdict_label}\n{feedback}';

commit;
