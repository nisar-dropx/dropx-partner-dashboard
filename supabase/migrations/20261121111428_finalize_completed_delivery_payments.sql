begin;
set local lock_timeout = '5s';

-- Finalization records an actual payment. Eligibility conflicts belong before
-- release, not at reconciliation. Keep payout invalidation for the paid day.
create or replace function public.payment_delivery_settlement_guard(p public.payment_requests)
returns void language plpgsql security definer set search_path='' as $$
declare
  target uuid;
  targets uuid[] := case when cardinality(p.delivery_payout_station_ids)>0
    then p.delivery_payout_station_ids else array[p.location_id] end;
begin
  perform public.lock_workforce_payment_allocation_company(p.company_id);
  perform public.workforce_bump_payout_period_dependency_revision(p.company_id,p.delivery_work_date);
  foreach target in array targets loop
    perform public.enqueue_workforce_payout_dependency_refresh(
      p.company_id,p.delivery_performer_workforce_id,target,
      p.delivery_work_date,p.delivery_work_date,p.updated_by);
  end loop;
end $$;

revoke all on function public.payment_delivery_settlement_guard(public.payment_requests)
  from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
