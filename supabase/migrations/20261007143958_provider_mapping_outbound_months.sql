-- Preserve the existing member list and add Amazon shipment month metadata.
-- Called server-side after host permission and location-scope checks.
create or replace function public.ops_cps_mapping_members(p_company uuid, p_station_ids uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $function$
  with scoped as materialized (
    select s.provider_employee_id, s.provider_employee_name, s.station_code,
      s.work_date, s.updated_at, s.client, s.amazon_delivery,
      upper(trim(s.provider_employee_id)) as member_key
    from public.cps_shipment_daily s
    join public.stations st on st.company_id = s.company_id and st.station_code = s.station_code
    where s.company_id = p_company
      and (p_station_ids is null or st.id = any(p_station_ids))
  ), latest as (
    select distinct on (station_code, member_key)
      provider_employee_id, provider_employee_name, station_code, work_date, member_key
    from scoped
    order by station_code, member_key, work_date desc, updated_at desc
  ), months as (
    select station_code, member_key,
      array_agg(distinct to_char(work_date, 'YYYY-MM') order by to_char(work_date, 'YYYY-MM') desc)
        as shipment_months,
      array_agg(distinct to_char(work_date, 'YYYY-MM') order by to_char(work_date, 'YYYY-MM') desc)
        filter (where amazon_delivery > 0) as outbound_months
    from scoped
    where client = 'Amazon'
    group by station_code, member_key
  )
  select coalesce(jsonb_agg(t order by t.station_code, upper(trim(t.provider_employee_id))), '[]'::jsonb)
  from (
    select l.provider_employee_id, l.provider_employee_name, l.station_code, l.work_date,
      coalesce(m.shipment_months, '{}'::text[]) as shipment_months,
      coalesce(m.outbound_months, '{}'::text[]) as outbound_months
    from latest l
    left join months m on m.station_code = l.station_code and m.member_key = l.member_key
  ) t;
$function$;

revoke all on function public.ops_cps_mapping_members(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ops_cps_mapping_members(uuid, uuid[]) to service_role;
