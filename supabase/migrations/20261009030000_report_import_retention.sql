-- report_import_rows had grown to 5.6 GB, half the database, on a 4 GB server
-- (outage 2026-10-08). It keeps a copy of every row of every uploaded file, and
-- two reports are uploaded several times a day:
--
--   edsp_outstanding_cash  each upload is a full copy of the outstanding list;
--                          COD ageing reads one upload per day (the last
--                          network upload completed by 20:30 IST).
--   amazon_shipments       each weekly file is re-uploaded daily; readers follow
--                          cps_shipment_daily.source_batch_id, so only the
--                          uploads that last fed a station/day are ever read.
--
-- Rows of uploads that no reader can reach are removed daily. The upload record
-- itself stays in report_import_batches, stamped with rows_pruned_at.
begin;
alter table public.report_import_batches add column rows_pruned_at timestamptz;

create function public.report_import_prunable_batches(p_limit integer default 500)
returns setof uuid language sql stable security invoker set search_path = public, pg_temp as $$
  with b as (
    select b.*, (b.created_at at time zone 'Asia/Kolkata')::date as d
    from public.report_import_batches b
    where b.source_type in ('edsp_outstanding_cash', 'amazon_shipments') and b.status in ('Completed', 'Failed')
  ), ageing as (
    -- The upload loadCodAgeing picks for each upload date.
    select distinct on (company_id, d) id from b
    where source_type = 'edsp_outstanding_cash' and status = 'Completed' and station_code is null
      and (created_at at time zone 'Asia/Kolkata')::time <= time '20:30'
      and (completed_at at time zone 'Asia/Kolkata') <= d + time '20:30'
    order by company_id, d, completed_at desc, id
  ), latest as (
    -- The closing position of each day, network-wide and per single-station upload.
    select distinct on (company_id, d, station_code) id from b
    where source_type = 'edsp_outstanding_cash' and status = 'Completed'
    order by company_id, d, station_code, created_at desc, id
  )
  select b.id from b
  where b.rows_pruned_at is null
    -- Never the last two days: an import may still be running or being reviewed.
    and b.created_at < now() - interval '2 days'
    and case
      when b.status = 'Failed' then true
      when b.source_type = 'amazon_shipments'
        then not exists (select 1 from public.cps_shipment_daily s where s.source_batch_id = b.id)
      -- A performance review keeps the upload it was written against, whatever its age.
      when exists (select 1 from public.ops_performance_reviews r where r.source_batch_id = b.id) then false
      when b.created_at < now() - interval '6 months' then true
      else b.id not in (select id from ageing) and b.id not in (select id from latest)
    end
  order by b.created_at
  limit greatest(p_limit, 1)
$$;

create function public.report_import_prune_batch(p_batch uuid, p_limit integer default 2000)
returns integer language plpgsql security invoker set search_path = public, pg_temp as $$
declare removed integer;
begin
  -- The caller's list may be stale; the rules decide again here.
  if not exists (select 1 from public.report_import_prunable_batches(100000) as id where id = p_batch) then return 0; end if;
  with gone as (
    delete from public.report_import_rows r
    where r.ctid = any (array(select o.ctid from public.report_import_rows o where o.batch_id = p_batch limit least(greatest(p_limit, 1), 10000)))
      and r.batch_id = p_batch
    returning 1)
  select count(*) into removed from gone;
  if not exists (select 1 from public.report_import_rows o where o.batch_id = p_batch) then
    update public.report_import_batches set rows_pruned_at = now() where id = p_batch;
  end if;
  return removed;
end $$;

revoke all on function public.report_import_prunable_batches(integer), public.report_import_prune_batch(uuid, integer) from public, anon, authenticated;
grant execute on function public.report_import_prunable_batches(integer), public.report_import_prune_batch(uuid, integer) to service_role;
commit;
