-- Surface Flipkart production uploads in the provider-first mapping month filter.
-- Amazon remains based on its outbound-delivery count; Flipkart uses the
-- normalized total_delivery count populated by the cycle importer.

set statement_timeout = '5min';

-- Keep the provider-first mapping scan index-only after adding Flipkart's
-- total_delivery to the grouped month query. Build the replacement first so
-- deployment never leaves this hot path without a supporting index.
create index if not exists cps_shipment_daily_mapping_members_v2_idx
  on public.cps_shipment_daily (
    company_id,
    station_code,
    (upper(btrim(provider_employee_id))),
    work_date desc,
    updated_at desc
  )
  include (provider_employee_id, provider_employee_name, client, amazon_delivery, total_delivery, c_return);

drop index if exists public.cps_shipment_daily_mapping_members_idx;

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
            (ranked.client = 'Amazon' and ranked.amazon_delivery > 0)
            or (ranked.client = 'Flipkart' and (ranked.total_delivery > 0 or ranked.c_return > 0))
          ),
        '{}'::text[]
      ) as outbound_months
    from ranked
    group by ranked.station_code, ranked.member_key
  ) member;
$function$;

revoke all on function public.ops_cps_mapping_members(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ops_cps_mapping_members(uuid, uuid[]) to service_role;

analyze public.cps_shipment_daily;
