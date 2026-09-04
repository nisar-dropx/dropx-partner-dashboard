-- Allow late-in / early-out permission regularization reasons.

begin;

alter table public.attendance_regularization_requests
  drop constraint if exists attendance_regularization_requests_reason_code_check;

alter table public.attendance_regularization_requests
  add constraint attendance_regularization_requests_reason_code_check
  check (
    reason_code in (
      'missed_in',
      'missed_out',
      'missed_both',
      'incorrect_in',
      'incorrect_out',
      'late_in_permission',
      'early_out_permission',
      'other'
    )
  );

commit;
