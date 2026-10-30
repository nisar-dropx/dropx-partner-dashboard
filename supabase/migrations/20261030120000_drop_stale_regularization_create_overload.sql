-- Drop the stale 15-arg create overload. It rejects late_in_permission /
-- early_out_permission and collides with the current 16-arg function when
-- PostgREST omits p_attachment_path_out, which surfaces as a failed submit.

begin;

drop function if exists public.hr_create_attendance_regularization_with_steps(
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  date,
  text,
  text,
  time without time zone,
  time without time zone,
  text,
  text,
  text,
  jsonb
);

commit;
