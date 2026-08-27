-- Target the proven HRMS query hotspots without changing application data.
create index if not exists biometric_raw_events_company_timelog_punch_idx
  on public.biometric_raw_events (company_id, punch_time desc, created_at desc)
  where event_type = 'TimeLog';

create index if not exists biometric_raw_events_company_device_timelog_punch_idx
  on public.biometric_raw_events (company_id, device_id, punch_time)
  where event_type = 'TimeLog';

create index if not exists biometric_raw_events_company_created_idx
  on public.biometric_raw_events (company_id, created_at desc);

create index if not exists attendance_punches_company_punch_time_idx
  on public.attendance_punches (company_id, punch_time desc);

create index if not exists attendance_punches_company_calculated_punch_idx
  on public.attendance_punches (company_id, calculated, punch_time desc);

create index if not exists attendance_punches_company_device_punch_idx
  on public.attendance_punches (company_id, device_id, punch_time);

create index if not exists report_import_rows_capacity_lookup_idx
  on public.report_import_rows (
    company_id,
    source_type,
    batch_id,
    station_code,
    work_date,
    row_number
  )
  where normalized_data is not null;
