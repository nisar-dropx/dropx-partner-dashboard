begin;

update public.mob_app_notification_rules
set
  title_template = 'Late check-in',
  body_template = 'You checked in {late_minutes} minutes late at {time}. Attendance penalty may apply under the People policy.',
  updated_at = now()
where event_code = 'attendance_late_in'
  and title_template = 'Late punch-in'
  and body_template = 'Punch captured at {time}. You arrived {late_minutes} minutes after your allowed shift time.';

update public.mob_app_notification_rules
set
  body_template = 'You punched out {early_minutes} minutes early at {time}. Short-hours deduction may apply under the People policy.',
  updated_at = now()
where event_code = 'attendance_early_out'
  and body_template = 'Punch-out captured at {time}. You left {early_minutes} minutes before your shift end.';

update public.mob_app_notification_rules
set
  title_template = 'Half day recorded',
  body_template = 'You worked {work_duration}. Half-day deduction may apply under the People attendance policy.',
  updated_at = now()
where event_code = 'attendance_half_day'
  and title_template = 'Half day marked'
  and body_template = 'Punch-out captured at {time}. You worked {work_duration}; attendance is marked half day under the current policy.';

update public.mob_app_notification_rules
set
  body_template = 'You worked {work_duration}; attendance is {outcome}. Deduction may apply under the People policy.',
  updated_at = now()
where event_code = 'attendance_short_day'
  and body_template = 'Punch-out captured at {time}. You worked {work_duration}; attendance is marked {outcome} under the current policy.';

update public.mob_app_notification_rules
set
  body_template = 'A punch is missing for {date}. Open Attendance and submit regularization.',
  updated_at = now()
where event_code = 'attendance_exception_review'
  and body_template = 'Punch captured at {time}. {outcome}.';

commit;
