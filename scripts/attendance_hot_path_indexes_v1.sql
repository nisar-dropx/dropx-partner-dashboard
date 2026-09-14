begin;

-- loadOpenShift() (src/lib/biometric/attendance.ts) runs on every attendance heartbeat,
-- every live-position-adjacent punch check, and every biometric/app-GPS punch — filtering
-- attendance_punches and attendance_daily by exactly (company_id, enrolment_id, punch_date).
-- Neither table had a composite index matching that filter; the closest existing indexes
-- (attendance_punches_company_punch_time_idx etc., from
-- dropx-hrms's 20260828140000_hrms_query_performance_indexes.sql) cover company_id +
-- punch_time-based lookups, not this one. At 1000+ workers this is one of the hottest
-- queries in the whole system, run far more often than it's written to, so it's worth
-- indexing precisely rather than relying on a broader index to filter the rest afterward.
create index if not exists attendance_punches_company_enrol_date_idx
  on public.attendance_punches (company_id, enrolment_id, punch_date, punch_time);

create index if not exists attendance_daily_company_enrol_date_idx
  on public.attendance_daily (company_id, enrolment_id, punch_date);

commit;
