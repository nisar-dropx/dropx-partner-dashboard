begin;

alter table public.mob_app_notification_rules
  drop constraint if exists mob_app_notification_rules_event_check;

alter table public.mob_app_notification_rules
  add constraint mob_app_notification_rules_event_check
  check (event_code in (
    'attendance_punch_in',
    'attendance_punch_out',
    'attendance_early_out',
    'attendance_exception_review',
    'attendance_half_day',
    'attendance_late_in',
    'attendance_overtime',
    'attendance_punch_in_reminder',
    'attendance_punch_out_reminder',
    'attendance_short_day',
    'profile_submitted',
    'profile_approved',
    'profile_returned',
    'attendance_regularization_submitted',
    'attendance_location_flagged',
    'attendance_forgot_punch_out',
    'communication_announcement',
    'leave_request_submitted',
    'advance_request_raised',
    'advance_request_approved',
    'advance_request_rejected',
    'exit_request_raised',
    'exit_request_approved',
    'exit_request_rejected'
  ));

notify pgrst, 'reload schema';

commit;
