begin;

update hr_company_settings
set partial_day_treatment = 'half_day',
    below_half_day_treatment = 'absent',
    updated_at = now()
where company_id in (
  select id from companies where upper(trim(name)) = 'DROPX LOGISTICS'
)
  and partial_day_treatment = 'review'
  and below_half_day_treatment = 'review';

update mob_app_notification_rules
set title_template = '{punch_title}',
    body_template = '{punch_notice}',
    updated_at = now()
where company_id in (
  select id from companies where upper(trim(name)) = 'DROPX LOGISTICS'
)
  and event_code in ('attendance_punch_in', 'attendance_punch_out')
  and title_template = 'Punch Captured'
  and body_template = 'Your punch was captured at {time} on {date}.';

commit;
