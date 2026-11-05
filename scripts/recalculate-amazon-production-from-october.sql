-- Authorized correction: buildSalaryData production classification, effective 2026-10-01.
-- Keep original import audit rows and payment history intact. Existing fact triggers
-- invalidate payout caches and enqueue publication refresh through the normal workflow.
-- No bank, paid-ledger, attendance, mapping, rate or publication snapshots are edited here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';
select pg_advisory_xact_lock(hashtextextended('workforce-pool:43866344-b550-4e8a-9a2d-9d23f3d8a997',0));

create temporary table amazon_production_repair_results (
  batch_id uuid, checked_rows bigint, changed_rows bigint, shifted_units numeric
) on commit drop;

do $repair$
declare
  co constant uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  batch uuid;
  checked bigint;
  changed bigint;
  shifted numeric;
begin
  for batch in
    select distinct source_batch_id from public.cps_shipment_daily
    where company_id=co and client='Amazon' and work_date>=date '2026-10-01'
    order by source_batch_id
  loop
    create temporary table amazon_production_repair_plan on commit drop as
    with source as materialized (
      select distinct on (r.row_hash) r.*
      from public.report_import_rows r
      where r.batch_id=batch and r.company_id=co and r.source_type='amazon_shipments'
        and r.normalized_data ? 'base_amazon_delivery'
      order by r.row_hash,r.row_number
    ), totals as (
      select r.work_date,r.station_code,r.external_worker_id,count(*) as source_rows,
        sum((r.normalized_data->>'amazon_delivery')::numeric) as old_amazon,
        sum((r.normalized_data->>'c_return')::numeric) as old_creturn,
        sum((r.normalized_data->>'total_delivery')::numeric) as old_total,
        sum((r.normalized_data->>'base_amazon_delivery')::numeric
          +coalesce((r.normalized_data->>'smd_delivery')::numeric,0)
          +coalesce((r.normalized_data->>'smd2_delivery')::numeric,0)
          +case when btrim(r.normalized_data->>'shipment_type')='Delivery'
            then coalesce((r.normalized_data->>'final_creturn_count')::numeric,0) else 0 end) as new_amazon,
        sum(case when btrim(r.normalized_data->>'shipment_type')='ReturnPickup'
          then coalesce((r.normalized_data->>'final_creturn_count')::numeric,0) else 0 end) as new_creturn,
        sum(coalesce((r.normalized_data->>'swa_delivery')::numeric,0)) as source_swa,
        sum(coalesce((r.normalized_data->>'mfn')::numeric,0)) as source_mfn,
        sum(coalesce((r.normalized_data->>'mfn_return')::numeric,0)) as source_mfn_return
      from source r group by r.work_date,r.station_code,r.external_worker_id
    )
    select f.*,t.source_rows,t.old_amazon,t.old_creturn,t.old_total,
      t.new_amazon,t.new_creturn,t.source_swa,t.source_mfn,t.source_mfn_return,
      t.new_amazon+t.source_swa as new_total,
      t.new_amazon+t.source_swa+t.new_creturn+t.source_mfn+t.source_mfn_return as new_activity
    from public.cps_shipment_daily f left join totals t
      on t.work_date=f.work_date and t.station_code=f.station_code
      and t.external_worker_id=f.provider_employee_id
    where f.company_id=co and f.client='Amazon' and f.source_batch_id=batch
      and f.work_date>=date '2026-10-01';

    if exists(select 1 from amazon_production_repair_plan p
      where p.source_rows is null or p.source_rows<>p.raw_row_count
        or row(p.swa_delivery,p.mfn,p.mfn_return) is distinct from row(p.source_swa,p.source_mfn,p.source_mfn_return)
        or (row(p.amazon_delivery,p.c_return,p.total_delivery) is distinct from row(p.old_amazon,p.old_creturn,p.old_total)
          and row(p.amazon_delivery,p.c_return,p.total_delivery) is distinct from row(p.new_amazon,p.new_creturn,p.new_total)))
    then
      raise exception 'Amazon production source is missing or has drifted for batch %; transaction rolled back',batch;
    end if;

    select count(*),coalesce(sum(p.new_total-p.total_delivery),0) into checked,shifted
      from amazon_production_repair_plan p;
    update public.cps_shipment_daily f
      set amazon_delivery=p.new_amazon,c_return=p.new_creturn,total_delivery=p.new_total,
        total_activity=p.new_activity,updated_at=clock_timestamp()
      from amazon_production_repair_plan p
      where f.id=p.id and f.source_batch_id=batch
        and row(f.amazon_delivery,f.c_return,f.total_delivery,f.total_activity)
          is distinct from row(p.new_amazon,p.new_creturn,p.new_total,p.new_activity);
    get diagnostics changed=row_count;
    insert into amazon_production_repair_results values(batch,checked,changed,shifted);
    drop table amazon_production_repair_plan;
  end loop;
end
$repair$;

select * from amazon_production_repair_results order by batch_id;
commit;
