-- Return exact outbound activity dates so Mapping Summary can validate short
-- and one-day mapping periods without treating them as full-month coverage.

set statement_timeout = '5min';

create or replace function public.ops_cps_mapping_members(p_company uuid, p_station_ids uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $function$
  with ranked as (
    select
      shipment.provider_employee_id,
      shipment.provider_employee_name,
      shipment.station_code,
      shipment.work_date,
      shipment.client,
      shipment.amazon_delivery,
      shipment.total_delivery,
      shipment.c_return,
      upper(trim(shipment.provider_employee_id)) as member_key,
      row_number() over (
        partition by shipment.station_code, upper(trim(shipment.provider_employee_id))
        order by shipment.work_date desc, shipment.updated_at desc
      ) as recency
    from public.cps_shipment_daily shipment
    join public.stations station
      on station.company_id = shipment.company_id
     and station.station_code = shipment.station_code
    where shipment.company_id = p_company
      and (p_station_ids is null or station.id = any(p_station_ids))
  )
  select coalesce(jsonb_agg(member order by member.station_code, upper(trim(member.provider_employee_id))), '[]'::jsonb)
  from (
    select
      max(ranked.provider_employee_id) filter (where ranked.recency = 1) as provider_employee_id,
      max(ranked.provider_employee_name) filter (where ranked.recency = 1) as provider_employee_name,
      ranked.station_code,
      max(ranked.work_date) filter (where ranked.recency = 1) as work_date,
      coalesce(
        array_agg(distinct to_char(ranked.work_date, 'YYYY-MM') order by to_char(ranked.work_date, 'YYYY-MM') desc)
          filter (where ranked.client in ('Amazon', 'Flipkart')),
        '{}'::text[]
      ) as shipment_months,
      coalesce(
        array_agg(distinct to_char(ranked.work_date, 'YYYY-MM') order by to_char(ranked.work_date, 'YYYY-MM') desc)
          filter (where
            ranked.work_date is not null
            and (
              (ranked.client = 'Amazon' and ranked.amazon_delivery > 0)
              or (ranked.client = 'Flipkart' and (ranked.total_delivery > 0 or ranked.c_return > 0))
            )
          ),
        '{}'::text[]
      ) as outbound_months,
      coalesce(
        array_agg(distinct to_char(ranked.work_date, 'YYYY-MM-DD') order by to_char(ranked.work_date, 'YYYY-MM-DD'))
          filter (where
            ranked.work_date is not null
            and (
              (ranked.client = 'Amazon' and ranked.amazon_delivery > 0)
              or (ranked.client = 'Flipkart' and (ranked.total_delivery > 0 or ranked.c_return > 0))
            )
          ),
        '{}'::text[]
      ) as outbound_dates
    from ranked
    group by ranked.station_code, ranked.member_key
  ) member;
$function$;

revoke all on function public.ops_cps_mapping_members(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ops_cps_mapping_members(uuid, uuid[]) to service_role;

comment on function public.ops_cps_mapping_members(uuid, uuid[]) is
  'Provider members with shipment/outbound months and exact outbound activity dates for date-effective mapping coverage.';

analyze public.cps_shipment_daily;
