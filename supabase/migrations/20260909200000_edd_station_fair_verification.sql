-- Prioritize unverified station stock and share each batch across locations.
-- A large station must not leave every other location waiting behind it.
create or replace function public.edd_claim_verification(p_token uuid,p_codes text[] default null,p_limit integer default 30)
returns setof public.edd_package_ledger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.edd_verification_lease set token=p_token,expires_at=now()+interval '110 seconds'
    where id=1 and expires_at<now();
  if not found then return; end if;
  return query with eligible as (
    select station_code,tracking_id,next_check_at,
      case when coalesce(source->>'ead',verification->>'edd',source->>'promisedDeliveryDate')=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD')
        then case when source->>'state' in ('INDUCTED','RECEIVED') and coalesce(verification->>'historyComplete','false')<>'true' then 0 else 1 end
        when coalesce(source->>'ead',verification->>'edd',source->>'promisedDeliveryDate','')='' then 3 else 2 end as priority
    from public.edd_package_ledger
    where (p_codes is null or station_code=any(p_codes)) and next_check_at<=now()
      and last_seen_at>now()-interval '3 days'
      and coalesce(source->>'ead',verification->>'edd',source->>'promisedDeliveryDate','')<=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD')
  ), ranked as (
    select *,row_number() over(partition by station_code order by priority,next_check_at,tracking_id) as station_rank from eligible
  ), candidates as (
    select station_code,tracking_id from ranked order by station_rank,priority,next_check_at,station_code
      limit least(greatest(p_limit,1),180)
  ) update public.edd_package_ledger l set next_check_at=now()+interval '10 minutes'
      from candidates c where l.station_code=c.station_code and l.tracking_id=c.tracking_id returning l.*;
end $$;
-- Recheck derived legacy transit facts; retained source observations stay intact.
update public.edd_package_ledger set next_check_at=now()
  where verified_at is not null and coalesce(verification->>'rulesVersion','1')<>'2';
