-- Scoped revenue facts for live P&L; no employee or salary payloads.
create or replace function public.finance_pnl_revenue_snapshot(p_company uuid, p_from date, p_through date, p_station_codes text[])
returns jsonb language sql stable security invoker set search_path = '' as $$
select jsonb_build_object('read_at', now(), 'shipments', '[]'::jsonb, 'costs', '[]'::jsonb,
'daily_shipments', coalesce((
      with current_source as materialized (
        select
          id, source_batch_id, station_code, work_date,
          provider_employee_id, client, total_delivery, amazon_delivery,
          swa_delivery, c_return, mfn, updated_at
        from public.cps_shipment_daily
        where company_id = p_company
          and work_date between p_from and p_through
          and station_code = any(p_station_codes)
      ), active_days as materialized (
        select distinct source_batch_id, station_code, work_date
        from current_source where lower(client) = 'amazon'
      ), active_audit as materialized (
        select
          r.id, r.batch_id, r.station_code, r.work_date,
          r.external_worker_id, r.row_number, r.normalized_data, r.raw_data
        from active_days a
        join public.report_import_rows r
          on r.company_id = p_company
          and r.source_type = 'amazon_shipments'
          and r.batch_id = a.source_batch_id
          and r.station_code = a.station_code
          and r.work_date = a.work_date
          and r.normalized_data is not null
      ), audit_grain as (
        select distinct on (
          c.id, lower(coalesce(r.normalized_data->>'shipment_type', ''))
        )
          c.id as source_id, r.normalized_data, r.raw_data
        from current_source c
        join active_audit r
          on r.batch_id = c.source_batch_id
          and r.station_code = c.station_code
          and r.work_date = c.work_date
          and r.external_worker_id = c.provider_employee_id
          and r.normalized_data is not null
        where lower(c.client) = 'amazon'
        order by
          c.id,
          lower(coalesce(r.normalized_data->>'shipment_type', '')),
          r.row_number,
          r.id
      ), metrics as materialized (
        select
          source_id,
          public.finance_report_count(
            normalized_data, raw_data, 'smd_delivery',
            array['overalldeliveredsmd']
          ) as smd,
          public.finance_report_count(
            normalized_data, raw_data, 'smd2_delivery',
            array['overalldeliveredsmd2', 'overalldeliveredsmd20']
          ) as smd2,
          public.finance_report_count(
            normalized_data, raw_data, 'ihs',
            array['finalihshandled']
          ) as ihs
        from audit_grain
      ), audit as (
        select
          source_id,
          case when count(*) filter (where smd is null or smd2 is null) = 0
            then sum(smd + smd2) end as smd,
          case when count(*) filter (where ihs is null) = 0
            then sum(ihs) end as ihs
        from metrics group by source_id
      )
      select jsonb_agg(to_jsonb(d) order by d.station_code, d.client, d.work_date)
      from (
        select
          c.station_code,
          c.client,
          c.work_date,
          case when count(*) filter (where c.total_delivery is null) = 0
            then sum(c.total_delivery)::text end as deliveries,
          case when count(*) filter (where c.amazon_delivery is null) = 0
            then sum(c.amazon_delivery)::text end as mg_deliveries,
          case when count(*) filter (where c.swa_delivery is null) = 0
            then sum(c.swa_delivery)::text end as swa,
          case when count(*) filter (where c.c_return is null) = 0
            then sum(c.c_return)::text end as returns,
          case when count(*) filter (where c.mfn is null) = 0
            then sum(c.mfn)::text end as mfn,
          case when count(*) filter (where a.smd is null or a.smd > c.total_delivery) = 0
            then sum(a.smd)::text end as smd,
          case when count(*) filter (where a.ihs is null) = 0
            then sum(a.ihs)::text end as ihs,
          count(*) filter (where a.smd is null or a.ihs is null)
            as missing_breakdown_rows,
          max(c.updated_at) as updated_at
        from current_source c
        left join audit a on a.source_id = c.id
        group by c.station_code, c.client, c.work_date
      ) d
), '[]'::jsonb),
'availability', jsonb_build_object(
'shipments', (select jsonb_build_object('from', min(work_date), 'to', max(work_date), 'updated_at', max(updated_at)) from public.cps_shipment_daily where company_id=p_company and station_code=any(p_station_codes)),
'fuel', (select jsonb_build_object('from', min(transaction_date), 'to', max(transaction_date), 'updated_at', max(created_at)) from public.cps_fuel_daily where company_id=p_company and station_code=any(p_station_codes)),
'cashbook', (select jsonb_build_object('from', min(expense_date), 'to', max(expense_date), 'updated_at', max(created_at)) from public.cps_cashbook_daily where company_id=p_company and station_code=any(p_station_codes))
));
$$;
revoke all on function public.finance_pnl_revenue_snapshot(uuid,date,date,text[]) from public,anon,authenticated;
grant execute on function public.finance_pnl_revenue_snapshot(uuid,date,date,text[]) to service_role;

-- Preserve existing revision history. Seed only missing SWA prices from the
-- corresponding delivery rate, including the configured parent rate for XPTs.
-- The provisional basis is visible and editable in Pricing Master.
with latest as (
 select distinct on(company_id,provider,station_code,effective_month) *
 from public.finance_pricing_revisions where company_id in (select id from public.companies where name='DROPX LOGISTICS') order by company_id,provider,station_code,effective_month,revision desc
), resolved as (
 select c.*, coalesce(nullif(c.rates->>'variable_slab',''),parent.rates->>'variable_slab') as swa_rate
 from latest c
 left join lateral (
  select p.rates from latest p where p.company_id=c.company_id and p.provider='Amazon'
   and p.station_code=c.rates->>'parent_station_code' and p.effective_month<=c.effective_month
  order by p.effective_month desc limit 1
 ) parent on true
 where c.provider='Amazon' and nullif(c.rates->>'swa_delivery_rate','') is null
)
insert into public.finance_pricing_revisions(company_id,provider,station_code,effective_month,revision,rates,slabs,slab_mode,reason,source_file)
select company_id,provider,station_code,effective_month,revision+1,
 rates || jsonb_build_object('swa_delivery_rate',swa_rate,'swa_rate_basis','Provisional: matched delivery rate; management instruction 2026-10-05'),
 slabs,slab_mode,'SWA provisional delivery rate copied from the corresponding station / parent delivery rate, per management instruction; review in Pricing Master.',source_file
from resolved where swa_rate is not null;
