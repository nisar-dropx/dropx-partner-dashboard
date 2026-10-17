begin;

-- Templates saved from the portal's text boxes arrive with Windows line endings (\r\n),
-- so 20261016160000 didn't recognise an untouched old reply layout and left it without
-- the review ({checks}). Normalise stored templates to \n, then move an untouched old
-- layout to the current default. Safe to run twice.
update public.report_bot_settings
set feedback_template = replace(feedback_template, E'\r\n', E'\n'), updated_at = now()
where feedback_template like E'%\r\n%';

update public.report_bot_settings
set feedback_template = E'{sender} *{report}*\n{verdict_label}\n{feedback}\n{checks}', updated_at = now()
where feedback_template = E'*{report}* · {sender}\n{verdict_label}\n{feedback}';

update public.report_bot_schedules
set first_reminder_template = replace(first_reminder_template, E'\r\n', E'\n'),
    followup_template = replace(followup_template, E'\r\n', E'\n'),
    overdue_template = replace(overdue_template, E'\r\n', E'\n'),
    updated_at = now()
where first_reminder_template like E'%\r\n%'
   or followup_template like E'%\r\n%'
   or overdue_template like E'%\r\n%';

commit;
