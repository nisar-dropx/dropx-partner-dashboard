begin;

insert into public.report_import_master (
  company_id,
  source_code,
  name,
  description,
  file_types,
  day_offset,
  upload_time,
  frequency,
  weekday,
  parser_type,
  dedupe_fields,
  is_active,
  requires_station,
  station_scope,
  requires_report_date,
  report_date_label,
  date_default_offset
)
select
  companies.id,
  'qc_store_health_daily',
  'Quick Commerce Store Health Scorecard',
  'Daily Quick Commerce Store Health Scorecard PDF (Store Health Metrics v6.2), D-2. Performance date T is created on T+1; Review Desk opens from T+2. Feeds Dark Store performance reviews.',
  array['pdf']::text[],
  -2,
  '11:00'::time,
  'daily',
  null::smallint,
  'qc_store_health_pdf',
  array['report date', 'station code']::text[],
  true,
  false,
  'none',
  false,
  null,
  -2
from public.companies
on conflict (company_id, source_code) do update set
  name = excluded.name,
  description = excluded.description,
  file_types = excluded.file_types,
  day_offset = excluded.day_offset,
  upload_time = excluded.upload_time,
  frequency = excluded.frequency,
  weekday = excluded.weekday,
  parser_type = excluded.parser_type,
  dedupe_fields = excluded.dedupe_fields,
  is_active = excluded.is_active,
  requires_station = excluded.requires_station,
  station_scope = excluded.station_scope,
  requires_report_date = excluded.requires_report_date,
  report_date_label = excluded.report_date_label,
  date_default_offset = excluded.date_default_offset,
  updated_at = now();

commit;
