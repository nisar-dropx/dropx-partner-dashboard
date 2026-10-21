begin;
-- Delivery success % only when assigned_count > 0 for the rollup. Amazon shipment
-- files do not supply assigned today; Flipkart cycle files do. Never divide by zero.
create or replace function public.ops_delivery_scorecard(p_company uuid, p_stations text[], p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
 with bounds as (
  select p_from f, p_to t, (p_to - p_from + 1) span, p_from - (p_to - p_from + 1) pf, p_from - 1 pt
  where p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 92),
 base as (
  select s.station_code, s.work_date, upper(btrim(s.provider_employee_id)) da, max(s.provider_employee_name) da_name,
   max(nullif(s.dropx_emp_code,'')) dropx_id,
   sum(coalesce(s.total_delivery,0)) delivered, sum(coalesce(s.assigned_count,0)) assigned,
   sum(coalesce(s.c_return,0)+coalesce(s.mfn_return,0)) returns, sum(coalesce(s.total_activity,0)) activity
  from cps_shipment_daily s cross join bounds b
  where s.company_id = p_company and s.station_code = any(p_stations) and s.work_date between b.pf and b.t
  group by 1,2,3),
 cur as (select base.* from base, bounds b where work_date between b.f and b.t),
 prev as (select base.* from base, bounds b where work_date between b.pf and b.pt),
 st as (
  select c.station_code, count(distinct c.work_date) days, count(distinct c.da) das, sum(c.delivered) delivered, sum(c.assigned) assigned,
   sum(c.returns) returns, sum(c.activity) activity, count(*) da_days
  from cur c group by 1),
 stp as (select station_code, sum(delivered) delivered, sum(assigned) assigned, count(*) da_days from prev group by 1),
 trend as (select station_code, work_date, sum(delivered) delivered, sum(assigned) assigned from cur group by 1,2),
 da as (
  select c.station_code, c.da, max(c.da_name) name, max(c.dropx_id) dropx_id, count(*) days, sum(c.delivered) delivered,
   sum(c.assigned) assigned, sum(c.returns) returns, max(c.work_date) last_day
  from cur c group by 1,2)
 select jsonb_build_object(
  'stations', coalesce((select jsonb_agg(jsonb_build_object(
    'station', st.station_code, 'days', st.days, 'das', st.das, 'delivered', st.delivered, 'assigned', st.assigned, 'returns', st.returns,
    'da_days', st.da_days, 'prev_delivered', coalesce(stp.delivered,0), 'prev_assigned', coalesce(stp.assigned,0), 'prev_da_days', coalesce(stp.da_days,0),
    'delivery_success_pct', case when st.assigned > 0 then round((st.delivered / st.assigned) * 100.0, 2) else null end,
    'trend', (select jsonb_agg(jsonb_build_array(t.work_date, t.delivered, t.assigned) order by t.work_date) from trend t where t.station_code = st.station_code)
   ) order by st.delivered desc) from st left join stp using (station_code)), '[]'::jsonb),
  'das', coalesce((select jsonb_agg(jsonb_build_object(
    'station', station_code, 'id', da, 'name', name, 'dropx_id', dropx_id, 'days', days,
    'delivered', delivered, 'assigned', assigned, 'returns', returns, 'last_day', last_day,
    'delivery_success_pct', case when assigned > 0 then round((delivered / assigned) * 100.0, 2) else null end
   ) order by station_code, delivered desc) from da), '[]'::jsonb),
  'latest', (select max(work_date) from cur))
$$;
revoke all on function public.ops_delivery_scorecard(uuid, text[], date, date) from public, anon, authenticated;
grant execute on function public.ops_delivery_scorecard(uuid, text[], date, date) to service_role;
notify pgrst, 'reload schema';
commit;
