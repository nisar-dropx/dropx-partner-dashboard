-- Support the historical attendance health proof's bounded punch scan.
create index if not exists attendance_punches_company_enrolment_date_time_id_idx
  on public.attendance_punches (
    company_id,
    enrolment_id,
    punch_date,
    punch_time,
    id
  );
