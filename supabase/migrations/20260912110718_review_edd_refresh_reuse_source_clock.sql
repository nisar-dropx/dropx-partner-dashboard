-- Reuse a recently collected worker snapshot without postponing its next
-- refresh by another full interval. Preserve ownership, retry and access rules.
create or replace function public.edd_finish_review_source(p_station_code text, p_source text, p_token uuid, p_source_at timestamptz, p_error text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_count integer;
begin
  if p_token is null then raise exception 'A lease token is required'; end if;
  if exists (select 1 from public.ops_review_edd_refresh_jobs where station_code = p_station_code and source = p_source and completed_token = p_token) then
    return true;
  end if;
  if p_error is null and (p_source_at is null or p_source_at > v_now or p_source_at < v_now - interval '15 minutes') then
    raise exception 'A fresh source timestamp is required';
  end if;
  update public.ops_review_edd_refresh_jobs j set
    source_at = case when p_error is null then p_source_at else j.source_at end,
    last_success_at = case when p_error is null then v_now else j.last_success_at end,
    consecutive_failures = case when p_error is null then 0 else j.consecutive_failures + 1 end,
    last_error = p_error, lease_token = null, lease_until = null,
    completed_token = p_token, last_completed_at = v_now,
    next_attempt_at = case when p_error is null then greatest(v_now + interval '30 seconds', p_source_at + interval '15 minutes')
      else v_now + make_interval(secs => least(300, 60 * (1 << least(j.consecutive_failures, 3)))) end
  where j.station_code = p_station_code and j.source = p_source and j.lease_token = p_token
    and j.lease_until > v_now;
  get diagnostics v_count = row_count;
  return v_count = 1 or exists (select 1 from public.ops_review_edd_refresh_jobs where station_code = p_station_code and source = p_source and completed_token = p_token);
end;
$$;
revoke all on function public.edd_finish_review_source(text,text,uuid,timestamptz,text) from public, anon, authenticated;
grant execute on function public.edd_finish_review_source(text,text,uuid,timestamptz,text) to service_role;
