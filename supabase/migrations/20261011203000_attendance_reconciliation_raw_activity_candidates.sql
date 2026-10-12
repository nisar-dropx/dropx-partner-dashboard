-- Narrow one-time historical catch-up to enrolments with raw TimeLog evidence.
-- This candidate set does not shrink as punches are repaired, so ordinary
-- advancing cursors cannot skip later ownership windows.
create or replace function public.attendance_reconciliation_raw_punch_days(
  p_start_at timestamptz,
  p_end_before timestamptz,
  p_company_id uuid default null
)
returns table (
  company_id uuid,
  enrolment_id text,
  punch_date date
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select distinct
    raw.company_id,
    btrim(raw.enrolment_id) as enrolment_id,
    (raw.punch_time at time zone 'Asia/Kolkata')::date as punch_date
  from public.biometric_raw_events as raw
  where (p_company_id is null or raw.company_id = p_company_id)
    and raw.event_type ilike 'timelog'
    and raw.punch_time is not null
    and raw.punch_time >= p_start_at
    and raw.punch_time < p_end_before
    and btrim(raw.enrolment_id) ~ '^[0-9]{1,20}$'
  order by raw.company_id, enrolment_id, punch_date;
$function$;

revoke all on function public.attendance_reconciliation_raw_punch_days(timestamptz, timestamptz, uuid) from public;
revoke all on function public.attendance_reconciliation_raw_punch_days(timestamptz, timestamptz, uuid) from anon;
revoke all on function public.attendance_reconciliation_raw_punch_days(timestamptz, timestamptz, uuid) from authenticated;
grant execute on function public.attendance_reconciliation_raw_punch_days(timestamptz, timestamptz, uuid) to service_role;
