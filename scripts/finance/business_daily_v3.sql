-- Optimize Finance audit lookups and parse each source metric once.
create or replace function public.finance_report_count(p_normalized jsonb, p_raw jsonb, p_key text, p_aliases text[])
returns numeric language plpgsql immutable security invoker set search_path = '' as $$
declare v text;
begin
  v := nullif(p_normalized->>p_key,'');
  if v is null then
    v := case p_key when 'ihs' then p_raw->>'final_ihs_handled'
      when 'smd_delivery' then p_raw->>'overall_delivered_smd'
      when 'smd2_delivery' then p_raw->>'overall_delivered_smd2.0' end;
  end if;
  if v is null then
    select value into v from jsonb_each_text(p_raw)
    where regexp_replace(lower(key),'[^a-z0-9]','','g') = any(p_aliases)
    order by key limit 1;
  end if;
  if v is null or btrim(v) !~ '^[0-9]+(\.[0-9]+)?$' then return null; end if;
  return v::numeric;
end;
$$;
revoke all on function public.finance_report_count(jsonb,jsonb,text,text[]) from public, anon, authenticated;
grant execute on function public.finance_report_count(jsonb,jsonb,text,text[]) to service_role;

-- Optimize the Finance audit lookup at station/day grain.
create or replace function public.finance_business_daily_snapshot(p_company uuid, p_from date, p_through date, p_station_codes text[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  -- Reuses the v1 date validation and monthly totals, so existing clients remain compatible.
  result := public.finance_business_snapshot(p_company,p_from,p_through,p_station_codes);
  return result || jsonb_build_object(
    'daily_shipments',coalesce((
      with current_source as materialized (
        select id,source_batch_id,station_code,work_date,provider_employee_id,client,total_delivery,mfn,updated_at from public.cps_shipment_daily
        where company_id=p_company and work_date between p_from and p_through
          and (p_station_codes is null or station_code=any(p_station_codes))
      ), active_days as materialized (
        select distinct source_batch_id,station_code,work_date from current_source where lower(client)='amazon'
      ), active_audit as materialized (
        -- Read each active station/batch/day once, rather than once for every associate.
        select r.id,r.batch_id,r.station_code,r.work_date,r.external_worker_id,r.row_number,r.normalized_data,r.raw_data
        from active_days a join public.report_import_rows r
          on r.company_id=p_company and r.source_type='amazon_shipments'
          and r.batch_id=a.source_batch_id and r.station_code=a.station_code and r.work_date=a.work_date
          and r.normalized_data is not null
      ), audit_grain as (
        -- Only the active CPS batch for each associate/day. Earlier re-imports must not add volume.
        select distinct on (c.id,lower(coalesce(r.normalized_data->>'shipment_type','')))
          c.id as source_id,r.normalized_data,r.raw_data
        from current_source c join active_audit r
          on r.batch_id=c.source_batch_id and r.station_code=c.station_code
          and r.work_date=c.work_date and r.external_worker_id=c.provider_employee_id
          and r.normalized_data is not null
        where lower(c.client)='amazon'
        order by c.id,lower(coalesce(r.normalized_data->>'shipment_type','')),r.row_number,r.id
      ), metrics as materialized (
        select source_id,
          public.finance_report_count(normalized_data,raw_data,'smd_delivery',array['overalldeliveredsmd']) as smd,
          public.finance_report_count(normalized_data,raw_data,'smd2_delivery',array['overalldeliveredsmd2','overalldeliveredsmd20']) as smd2,
          public.finance_report_count(normalized_data,raw_data,'ihs',array['finalihshandled']) as ihs
        from audit_grain
      ), audit as (
        select source_id,
          case when count(*) filter(where smd is null or smd2 is null)=0 then sum(smd+smd2) end as smd,
          case when count(*) filter(where ihs is null)=0 then sum(ihs) end as ihs
        from metrics group by source_id
      )
      select jsonb_agg(to_jsonb(d) order by d.station_code,d.client,d.work_date) from (
        select c.station_code,c.client,c.work_date,
          case when count(*) filter(where c.total_delivery is null)=0 then sum(c.total_delivery)::text end as deliveries,
          case when count(*) filter(where c.mfn is null)=0 then sum(c.mfn)::text end as mfn,
          case when count(*) filter(where a.smd is null or a.smd>c.total_delivery)=0 then sum(a.smd)::text end as smd,
          case when count(*) filter(where a.ihs is null)=0 then sum(a.ihs)::text end as ihs,
          count(*) filter(where a.smd is null or a.ihs is null) as missing_breakdown_rows,
          max(c.updated_at) as updated_at
        from current_source c left join audit a on a.source_id=c.id
        group by c.station_code,c.client,c.work_date
      ) d
    ),'[]'::jsonb),
    'daily_costs',coalesce((select jsonb_agg(to_jsonb(c) order by c.station_code,c.work_date) from (
      select station_code,work_date,
        case when count(*) filter(where total_cost is null)=0 then sum(total_cost)::text end as total,
        max(updated_at) as updated_at
      from public.cps_station_daily where company_id=p_company and work_date between p_from and p_through
        and (p_station_codes is null or station_code=any(p_station_codes))
      group by station_code,work_date
    ) c),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.finance_business_daily_snapshot(uuid,date,date,text[]) from public, anon, authenticated;
grant execute on function public.finance_business_daily_snapshot(uuid,date,date,text[]) to service_role;
