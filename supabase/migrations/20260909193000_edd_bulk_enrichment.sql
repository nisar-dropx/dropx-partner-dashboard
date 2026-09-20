-- Private, bounded enrichment of existing EDD records only; no source-table writes.
create function public.edd_apply_summaries(p_station text, p_rows jsonb, p_observed_at timestamptz)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare affected integer;
begin
  if jsonb_array_length(p_rows)>300 then raise exception 'Summary batch too large'; end if;
  update public.edd_package_ledger l set
    source=l.source || jsonb_strip_nulls(r.value - 'trackingId') ||
      case when coalesce(l.source->>'internalEAD','') ~ '^\d{4}-\d{2}-\d{2}$'
        then jsonb_build_object('ead',l.source->>'internalEAD') else '{}'::jsonb end,
    source_at=p_observed_at
  from jsonb_array_elements(p_rows) r
  where l.station_code=p_station and l.tracking_id=r.value->>'trackingId' and l.source_at<=p_observed_at;
  get diagnostics affected=row_count;
  return affected;
end $$;
revoke all on function public.edd_apply_summaries(text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.edd_apply_summaries(text,jsonb,timestamptz) to service_role;

create or replace function public.edd_claim_verification(p_token uuid,p_codes text[] default null,p_limit integer default 30)
returns setof public.edd_package_ledger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.edd_verification_lease set token=p_token,expires_at=now()+interval '110 seconds'
    where id=1 and expires_at<now();
  if not found then return; end if;
  return query with candidates as (
    select station_code,tracking_id from public.edd_package_ledger
    where (p_codes is null or station_code=any(p_codes)) and next_check_at<=now()
      and last_seen_at>now()-interval '3 days'
      and coalesce(source->>'ead',verification->>'edd','')<=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD')
    order by case when coalesce(source->>'ead',verification->>'edd')=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') then 0
      when coalesce(source->>'ead',verification->>'edd','')='' then 1 else 2 end,
      next_check_at,station_code,tracking_id
    limit least(greatest(p_limit,1),180) for update skip locked
  ) update public.edd_package_ledger l set next_check_at=now()+interval '10 minutes'
      from candidates c where l.station_code=c.station_code and l.tracking_id=c.tracking_id returning l.*;
end $$;
