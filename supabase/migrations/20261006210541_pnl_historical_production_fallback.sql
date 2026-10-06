-- Estimates are Finance-only; uploaded inputs and payroll remain authoritative.
create table public.ops_cps_production_fallback_policies (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 field_code text not null,
 mode text not null check (mode in ('disabled','associate_average','associate_then_station')),
 lookback_months integer not null check (lookback_months between 1 and 12),
 minimum_history_days integer not null check (minimum_history_days between 1 and 366),
 effective_from date not null,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 unique(company_id,field_code,effective_from),
 foreign key(company_id,field_code) references public.payment_fields(company_id,code)
);
alter table public.ops_cps_production_fallback_policies enable row level security;
revoke all on public.ops_cps_production_fallback_policies from public,anon,authenticated;
grant select,insert,update on public.ops_cps_production_fallback_policies to service_role;
create trigger cps_production_fallback_change after insert or update on public.ops_cps_production_fallback_policies
 for each row execute function public.ops_cps_record_configuration_change();

-- Use import coverage dates: a monthly KM total posted on month-end is not one day's travel.
create function public.ops_cps_production_history(p_company uuid,p_from date,p_through date)
returns jsonb language sql stable security invoker set search_path='' as $$
 with history as materialized (
 select i.id,i.workforce_id,i.station_id,i.payment_field_id,i.field_code_snapshot,i.units,
 coalesce(b.effective_from,i.work_date) period_from,coalesce(b.effective_to,i.work_date) period_to
 from public.workforce_custom_production_inputs i
 left join public.workforce_payout_import_batches b on b.id=i.source_batch_id and b.company_id=i.company_id
 where i.company_id=p_company and i.work_date between p_from and p_through
 and p_through>=p_from and p_through-p_from<=400
 ), counted as (
 select h.*,coalesce(
 (select case when count(*)=1 then max(a.quantity) end from public.workforce_payout_attendance_values a
 where a.company_id=p_company and a.workforce_id=h.workforce_id and a.station_id=h.station_id
 and a.attendance_basis='days' and a.effective_from=h.period_from and a.effective_to=h.period_to),
 (select count(distinct work_day) from (
 select a.punch_date as work_day from public.attendance_daily a join public.workforce w on w.id=h.workforce_id and w.company_id=p_company
 where a.company_id=p_company and a.punch_date between h.period_from and h.period_to
 and (a.workforce_id=w.id or (w.source_profile_type='employee' and a.employee_id=w.source_profile_id)
 or (w.source_profile_type='contractor' and a.contractor_id=w.source_profile_id)
 or (w.source_profile_type='field_executive' and a.field_executive_id=w.source_profile_id)) and a.status in ('P','HD')
 union
 select s.work_date from public.cps_shipment_daily s join public.stations st on st.company_id=p_company and st.id=h.station_id and st.station_code=s.station_code
 where s.company_id=p_company and s.work_date between h.period_from and h.period_to and s.total_activity>0
 and exists(select 1 from public.field_executive_provider_mappings m
 join public.workforce w on w.id=h.workforce_id and w.company_id=p_company
 join public.providers pr on pr.id=m.provider_id and pr.company_id=p_company
 where m.company_id=p_company and (m.workforce_id=w.id or (w.source_profile_type='employee' and m.employee_id=w.source_profile_id)
 or (w.source_profile_type='contractor' and m.contractor_id=w.source_profile_id)
 or (w.source_profile_type='field_executive' and m.field_executive_id=w.source_profile_id))
 and m.provider_member_id=s.provider_employee_id and (m.station_id=h.station_id or m.station_id is null)
 and lower(pr.code||' '||pr.name) like '%'||lower(s.client)||'%'
 and m.status in ('active','closed') and m.effective_from<=s.work_date and coalesce(m.effective_to,s.work_date)>=s.work_date)
 ) workdays)
 ) work_days from history h
 ) select coalesce(jsonb_agg(counted),'[]'::jsonb) from counted;
$$;
revoke all on function public.ops_cps_production_history(uuid,date,date) from public,anon,authenticated;
grant execute on function public.ops_cps_production_history(uuid,date,date) to service_role;
