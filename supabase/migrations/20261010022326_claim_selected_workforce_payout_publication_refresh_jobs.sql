begin;

-- Targeted repairs must not lease unrelated queue work. Keep the canonical
-- queue claimant unchanged for the recurring drain, and expose a separately
-- scoped service boundary for one company, a supplied Workforce set, and one
-- exact payout month.
create or replace function public.workforce_claim_selected_payout_publication_refresh_jobs(
  p_limit integer,
  p_company_id uuid,
  p_workforce_ids uuid[],
  p_period_start date,
  p_period_end date
)
returns setof public.workforce_payout_publication_refresh_jobs
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Claim between 1 and 100 payout publication refresh jobs.';
  end if;
  if p_company_id is null then
    raise exception 'A company is required to claim selected payout publication refresh jobs.';
  end if;
  if p_workforce_ids is null
    or cardinality(p_workforce_ids) < 1
    or cardinality(p_workforce_ids) > 10000
    or array_position(p_workforce_ids, null) is not null
  then
    raise exception 'Supply between 1 and 10000 Workforce IDs without null values.';
  end if;
  if (
    select count(*)
    from unnest(p_workforce_ids) supplied(workforce_id)
  ) <> (
    select count(distinct supplied.workforce_id)
    from unnest(p_workforce_ids) supplied(workforce_id)
  ) then
    raise exception 'Supply each Workforce ID only once.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Selected payout publication refresh jobs require one complete calendar month.';
  end if;

  -- Match the canonical ten-minute lease and final-attempt dead-letter sweep,
  -- but mutate only work inside the explicitly supplied repair scope.
  update public.workforce_payout_publication_refresh_jobs job
  set status = 'failed',
      claim_token = null,
      claimed_at = null,
      next_attempt_at = null,
      failed_at = clock_timestamp(),
      last_error = coalesce(job.last_error, 'Refresh worker lease expired after the final attempt.'),
      updated_at = clock_timestamp()
  where job.status = 'processing'
    and job.claimed_at < clock_timestamp() - interval '10 minutes'
    and job.claim_attempts >= job.max_attempts
    and job.company_id = p_company_id
    and job.workforce_id = any(p_workforce_ids)
    and job.period_start = p_period_start
    and job.period_end = p_period_end;

  return query
  with eligible as (
    select
      job.id,
      job.input_batch_id,
      job.created_at,
      row_number() over (
        partition by job.company_id, job.workforce_id, job.station_id,
          job.period_start, job.period_end
        order by job.created_at, job.id
      ) as identity_order
    from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.workforce_id = any(p_workforce_ids)
      and job.period_start = p_period_start
      and job.period_end = p_period_end
      and job.claim_attempts < job.max_attempts
      and (
        (
          job.status = 'pending'
          and job.next_attempt_at <= clock_timestamp()
        )
        or (
          job.status = 'processing'
          and job.claimed_at < clock_timestamp() - interval '10 minutes'
        )
      )
      and not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs active
        where active.company_id = job.company_id
          and active.workforce_id = job.workforce_id
          and active.station_id = job.station_id
          and active.period_start = job.period_start
          and active.period_end = job.period_end
          and active.status = 'processing'
          and active.claimed_at >= clock_timestamp() - interval '10 minutes'
      )
      and not exists (
        select 1
        from public.workforce_payout_publication_refresh_jobs predecessor
        where predecessor.company_id = job.company_id
          and predecessor.workforce_id = job.workforce_id
          and predecessor.station_id = job.station_id
          and predecessor.period_start = job.period_start
          and predecessor.period_end = job.period_end
          and predecessor.status in ('pending', 'processing')
          and (predecessor.created_at, predecessor.id) < (job.created_at, job.id)
      )
  ), target_batch as (
    -- Preserve the canonical one-batch boundary: concurrent callers may share
    -- this oldest batch through SKIP LOCKED but cannot spill into another.
    select eligible.input_batch_id
    from eligible
    where eligible.identity_order = 1
    group by eligible.input_batch_id
    order by min(eligible.created_at), eligible.input_batch_id
    limit 1
  ), candidates as (
    select job.id
    from public.workforce_payout_publication_refresh_jobs job
    join eligible on eligible.id = job.id and eligible.identity_order = 1
    join target_batch on target_batch.input_batch_id = job.input_batch_id
    order by eligible.created_at, job.id
    limit p_limit
    for update of job skip locked
  ), claimed as (
    update public.workforce_payout_publication_refresh_jobs job
    set status = 'processing',
        claim_attempts = job.claim_attempts + 1,
        claim_token = gen_random_uuid(),
        claimed_at = clock_timestamp(),
        next_attempt_at = null,
        last_error = null,
        updated_at = clock_timestamp()
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select claimed.*
  from claimed
  order by claimed.created_at, claimed.id;
end
$function$;

comment on function public.workforce_claim_selected_payout_publication_refresh_jobs(
  integer, uuid, uuid[], date, date
) is
  'Claims selected company/Workforce/exact-month refresh work while preserving the canonical ten-minute lease, final-attempt dead-letter, strict predecessor, one-oldest-batch, bounded-attempt, and SKIP LOCKED semantics.';

revoke all on function public.workforce_claim_selected_payout_publication_refresh_jobs(
  integer, uuid, uuid[], date, date
) from public, anon, authenticated, service_role;

grant execute on function public.workforce_claim_selected_payout_publication_refresh_jobs(
  integer, uuid, uuid[], date, date
) to service_role;

notify pgrst, 'reload schema';

commit;
