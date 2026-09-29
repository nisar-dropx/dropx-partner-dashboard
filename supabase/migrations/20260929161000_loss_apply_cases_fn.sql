-- One-call, atomic apply of a changed loss pull (worker sends parsed cases as jsonb).
-- Upserts cases in place, deletes cases no longer in the file, rebuilds station
-- totals for the new run, and keeps only the latest 10 runs per report.
begin;

create or replace function public.loss_apply_cases(p_report text, p_run jsonb, p_cases jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run uuid;
begin
  insert into loss_report_runs (report, status, source_file, source_week, source_created_at, period_label,
    source_total_count, headers, station_column, amount_column, reference_column, total_rows, total_amount,
    triggered_by, content_hash, checked_at, finished_at)
  select p_report, 'completed', p_run->>'source_file', p_run->>'source_week', p_run->>'source_created_at',
    p_run->>'period_label', (p_run->>'source_total_count')::int, coalesce(p_run->'headers', '[]'::jsonb),
    p_run->>'station_column', p_run->>'amount_column', p_run->>'reference_column',
    jsonb_array_length(p_cases),
    coalesce((select sum((c->>'amount')::numeric) from jsonb_array_elements(p_cases) c), 0),
    p_run->>'triggered_by', p_run->>'content_hash', now(), now()
  returning id into v_run;

  insert into loss_cases (report, case_key, run_id, tid, tid_approximate, station_code, amount, case_status,
    category, sub_category, impact_date, closed_date, da_name, remarks, period, extra, updated_at)
  select p_report, c.case_key, v_run, c.tid, coalesce(c.tid_approximate, false), c.station_code, c.amount,
    c.case_status, c.category, c.sub_category, c.impact_date, c.closed_date, c.da_name, c.remarks, c.period,
    coalesce(c.extra, '{}'::jsonb), now()
  from jsonb_to_recordset(p_cases) as c(case_key text, tid text, tid_approximate boolean, station_code text,
    amount numeric, case_status text, category text, sub_category text, impact_date date, closed_date date,
    da_name text, remarks text, period text, extra jsonb)
  on conflict (report, case_key) do update set
    run_id = excluded.run_id, tid = excluded.tid, tid_approximate = excluded.tid_approximate,
    station_code = excluded.station_code, amount = excluded.amount, case_status = excluded.case_status,
    category = excluded.category, sub_category = excluded.sub_category, impact_date = excluded.impact_date,
    closed_date = excluded.closed_date, da_name = excluded.da_name, remarks = excluded.remarks,
    period = excluded.period, extra = excluded.extra, updated_at = now();

  delete from loss_cases where report = p_report and run_id is distinct from v_run;

  insert into loss_report_station_totals (run_id, report, station_code, row_count, total_amount)
  select v_run, p_report, coalesce(station_code, 'UNMAPPED'), count(*), coalesce(sum(amount), 0)
  from loss_cases where report = p_report group by 1, 2, 3;

  delete from loss_report_runs where report = p_report and id in (
    select id from loss_report_runs where report = p_report order by started_at desc offset 10);

  return v_run;
end;
$$;

revoke all on function public.loss_apply_cases(text, jsonb, jsonb) from public, anon, authenticated;

commit;
