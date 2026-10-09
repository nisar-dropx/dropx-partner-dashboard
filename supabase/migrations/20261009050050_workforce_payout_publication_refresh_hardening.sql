begin;

-- A refresh claim is a lease, not just a timestamp. A worker must present the
-- exact token issued by its claim before it may complete or release a job.
alter table public.workforce_payout_publication_refresh_jobs
  add column claim_token uuid,
  add column next_attempt_at timestamptz,
  add column failed_at timestamptz,
  add column max_attempts smallint not null default 5;

update public.workforce_payout_publication_refresh_jobs
set claim_token = case when status = 'processing' then gen_random_uuid() else null end,
    next_attempt_at = case when status = 'pending' then clock_timestamp() else null end,
    failed_at = null;

alter table public.workforce_payout_publication_refresh_jobs
  drop constraint workforce_payout_publication_refresh_jobs_status_check,
  drop constraint workforce_payout_publication_refresh_jobs_state_shape_check;

alter table public.workforce_payout_publication_refresh_jobs
  add constraint workforce_payout_publication_refresh_jobs_status_check
    check (status in ('pending', 'processing', 'completed', 'failed')),
  add constraint workforce_payout_publication_refresh_jobs_max_attempts_check
    check (max_attempts between 1 and 10),
  add constraint workforce_payout_publication_refresh_jobs_attempt_bound_check
    check (claim_attempts <= max_attempts),
  add constraint workforce_payout_publication_refresh_jobs_state_shape_check
    check (
      (
        status = 'pending'
        and claim_token is null
        and claimed_at is null
        and next_attempt_at is not null
        and failed_at is null
        and completed_at is null
        and published_publication_id is null
      )
      or (
        status = 'processing'
        and claim_token is not null
        and claimed_at is not null
        and next_attempt_at is null
        and failed_at is null
        and completed_at is null
        and published_publication_id is null
      )
      or (
        status = 'completed'
        and claim_token is null
        and claimed_at is not null
        and next_attempt_at is null
        and failed_at is null
        and completed_at is not null
        and published_publication_id is not null
      )
      or (
        status = 'failed'
        and claim_token is null
        and claimed_at is null
        and next_attempt_at is null
        and failed_at is not null
        and completed_at is null
        and published_publication_id is null
        and last_error is not null
      )
    );

create index workforce_payout_refresh_jobs_retry_idx
  on public.workforce_payout_publication_refresh_jobs (next_attempt_at, created_at, id)
  where status = 'pending';
create index workforce_payout_refresh_jobs_failed_idx
  on public.workforce_payout_publication_refresh_jobs (failed_at desc, company_id)
  where status = 'failed';
create index workforce_payout_refresh_jobs_failed_identity_idx
  on public.workforce_payout_publication_refresh_jobs (
    company_id, workforce_id, station_id, period_start, period_end, created_at, id
  )
  where status = 'failed';

comment on column public.workforce_payout_publication_refresh_jobs.claim_token is
  'Opaque lease ownership token. Apply/failure RPCs reject a stale worker after the lease is reclaimed.';
comment on column public.workforce_payout_publication_refresh_jobs.next_attempt_at is
  'Earliest retry time after bounded exponential backoff.';
comment on column public.workforce_payout_publication_refresh_jobs.failed_at is
  'Dead-letter timestamp after the bounded claim-attempt budget is exhausted.';

-- All queue mutation goes through token-checking security-definer RPCs.
revoke update on table public.workforce_payout_publication_refresh_jobs from service_role;
drop policy if exists workforce_payout_publication_refresh_jobs_service_failure_reset
  on public.workforce_payout_publication_refresh_jobs;

create or replace function public.guard_workforce_payout_refresh_job_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_claims jsonb;
begin
  if new.status = 'completed' and old.status = 'processing' then
    v_claims := nullif(pg_catalog.current_setting(
      'app.workforce_payout_refresh_claims', true
    ), '')::jsonb;
    if v_claims is null or not exists (
      select 1
      from jsonb_array_elements(v_claims) supplied
      where supplied ->> 'job_id' = old.id::text
        and supplied ->> 'claim_token' = old.claim_token::text
    ) then
      raise exception 'The payout publication refresh lease changed. Reclaim and recalculate the job.';
    end if;
  end if;

  if new.status = 'pending' then
    new.claim_token := null;
    new.claimed_at := null;
    new.failed_at := null;
    new.completed_at := null;
    new.published_publication_id := null;
    new.next_attempt_at := coalesce(new.next_attempt_at, clock_timestamp());
  elsif new.status = 'processing' then
    if new.claim_token is null or new.claimed_at is null then
      raise exception 'A processing payout publication refresh requires an owned lease.';
    end if;
    new.next_attempt_at := null;
    new.failed_at := null;
    new.completed_at := null;
    new.published_publication_id := null;
  elsif new.status = 'completed' then
    new.claim_token := null;
    new.next_attempt_at := null;
    new.failed_at := null;
  elsif new.status = 'failed' then
    new.claim_token := null;
    new.claimed_at := null;
    new.next_attempt_at := null;
    new.completed_at := null;
    new.published_publication_id := null;
    new.failed_at := coalesce(new.failed_at, clock_timestamp());
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_refresh_jobs_00_state_guard
  on public.workforce_payout_publication_refresh_jobs;
create trigger workforce_payout_refresh_jobs_00_state_guard
before update on public.workforce_payout_publication_refresh_jobs
for each row execute function public.guard_workforce_payout_refresh_job_state();

-- Preserve the original submission audit. The publication revision carries
-- the input author/batch audit; silently refreshing its calculation must not
-- make the original review look newly submitted by another person or time.
create or replace function public.preserve_workforce_payout_review_submission_audit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.calculation_snapshot is distinct from old.calculation_snapshot
    and old.subject_type = 'workforce'
    and exists (
      select 1
      from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = old.company_id
        and job.workforce_id = old.subject_id
        and job.station_id = old.location_id
        and job.period_start = old.period_start
        and job.period_end = old.period_end
        and job.status = 'processing'
    )
  then
    new.submitted_by := old.submitted_by;
    new.submitted_at := old.submitted_at;
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_review_submissions_50_preserve_refresh_audit
  on public.workforce_payout_review_submissions;
create trigger workforce_payout_review_submissions_50_preserve_refresh_audit
before update on public.workforce_payout_review_submissions
for each row execute function public.preserve_workforce_payout_review_submission_audit();

-- Keep the pre-existing attendance-policy mutex, but acquire Workforce rows
-- before company mutexes so all payout writers use the same explicit order.
create or replace function public.lock_workforce_attendance_policy_review_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.subject_type = 'workforce' then
      perform 1 from public.workforce workforce
      where workforce.company_id = new.company_id and workforce.id = new.subject_id
      for update;
    end if;
    perform public.lock_workforce_payment_allocation_company(new.company_id);
  elsif tg_op = 'DELETE' then
    if old.subject_type = 'workforce' then
      perform 1 from public.workforce workforce
      where workforce.company_id = old.company_id and workforce.id = old.subject_id
      for update;
    end if;
    perform public.lock_workforce_payment_allocation_company(old.company_id);
  else
    perform 1
    from public.workforce workforce
    where (old.subject_type = 'workforce'
        and workforce.company_id = old.company_id
        and workforce.id = old.subject_id)
       or (new.subject_type = 'workforce'
        and workforce.company_id = new.company_id
        and workforce.id = new.subject_id)
    order by workforce.company_id, workforce.id
    for update;

    if old.company_id::text <= new.company_id::text then
      perform public.lock_workforce_payment_allocation_company(old.company_id);
      if new.company_id is distinct from old.company_id then
        perform public.lock_workforce_payment_allocation_company(new.company_id);
      end if;
    else
      perform public.lock_workforce_payment_allocation_company(new.company_id);
      perform public.lock_workforce_payment_allocation_company(old.company_id);
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_review_submissions_00_attendance_policy_lock
  on public.workforce_payout_review_submissions;
create trigger workforce_payout_review_submissions_00_attendance_policy_lock
before insert or update or delete on public.workforce_payout_review_submissions
for each row execute function public.lock_workforce_attendance_policy_review_submission();

-- No terminal review decision may overtake a queued publication refresh.
create or replace function public.guard_workforce_payout_review_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status in ('approved', 'cancelled')
    and old.subject_type = 'workforce'
    and exists (
      select 1
      from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = old.company_id
        and job.workforce_id = old.subject_id
        and job.station_id = old.location_id
        and job.period_start = old.period_start
        and job.period_end = old.period_end
        and job.status in ('pending', 'processing', 'failed')
    )
  then
    raise exception 'This payout has an unresolved publication refresh. Replay failed work or wait for the updated payout before approving or cancelling it.';
  end if;

  if old.status = 'under_review'
    and new.status in ('returned', 'approved', 'cancelled') then
    return new;
  end if;
  if old.status = 'returned'
    and new.status in ('under_review', 'cancelled') then
    return new;
  end if;
  if old.status in ('approved', 'cancelled') then
    raise exception 'An approved or cancelled payout review cannot be reopened or changed.';
  end if;
  raise exception 'Invalid payout review status transition from % to %.', old.status, new.status;
end
$function$;

drop trigger if exists workforce_payout_review_submissions_00_status_guard
  on public.workforce_payout_review_submissions;
create trigger workforce_payout_review_submissions_00_status_guard
before update of status on public.workforce_payout_review_submissions
for each row execute function public.guard_workforce_payout_review_status_transition();

-- A row-level BEFORE UPDATE trigger cannot establish lock order: PostgreSQL
-- already owns the target review tuple before invoking it. Keep the established
-- public RPC name, but put a Workforce -> company mutex boundary in front of its
-- original implementation before revoking direct review-table updates.
alter function public.workforce_send_payouts_for_review(
  uuid, uuid, date, date, jsonb, uuid[]
)
  rename to workforce_send_payouts_for_review_without_lock_order;

revoke all on function public.workforce_send_payouts_for_review_without_lock_order(
  uuid, uuid, date, date, jsonb, uuid[]
) from public, anon, authenticated, service_role;

create or replace function public.workforce_send_payouts_for_review(
  p_company uuid,
  p_actor uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_locations uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_saved integer;
begin
  if p_company is not null
    and p_items is not null
    and jsonb_typeof(p_items) = 'array'
  then
    perform 1
    from public.workforce workforce
    where workforce.company_id = p_company
      and pg_catalog.lower(workforce.id::text) in (
        select pg_catalog.lower(pg_catalog.btrim(selected ->> 'subject_id'))
        from jsonb_array_elements(p_items) selected
        where pg_catalog.lower(pg_catalog.btrim(selected ->> 'subject_type')) = 'workforce'
          and nullif(pg_catalog.btrim(selected ->> 'subject_id'), '') is not null
      )
    order by workforce.id
    for update;

    perform public.lock_workforce_payment_allocation_company(p_company);
  end if;

  v_saved := public.workforce_send_payouts_for_review_without_lock_order(
    p_company,
    p_actor,
    p_period_start,
    p_period_end,
    p_items,
    p_locations
  );
  return v_saved;
end
$function$;

-- The notification publisher already takes Workforce locks followed by the
-- company mutex. Run it with its owner privileges after service_role loses the
-- table UPDATE privilege below.
alter function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) security definer;

-- All external review-state changes use the same Workforce -> company -> review
-- order as imports, publication and refresh apply. expected_status makes retries
-- optimistic and prevents a delayed request from overwriting a newer decision.
create or replace function public.workforce_transition_payout_review_status(
  p_company_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_status text,
  p_new_status text,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_review_id uuid;
  v_changed integer;
  v_subject_type text := pg_catalog.lower(pg_catalog.btrim(p_subject_type));
  v_expected_status text := pg_catalog.lower(pg_catalog.btrim(p_expected_status));
  v_new_status text := pg_catalog.lower(pg_catalog.btrim(p_new_status));
begin
  if p_company_id is null or p_subject_id is null or p_location_id is null
    or p_period_start is null or p_period_end is null or p_period_end < p_period_start
    or nullif(pg_catalog.btrim(p_subject_type), '') is null
    or nullif(pg_catalog.btrim(p_expected_status), '') is null
    or nullif(pg_catalog.btrim(p_new_status), '') is null
    or v_subject_type not in ('workforce', 'helper')
    or v_expected_status not in ('under_review', 'returned', 'approved', 'cancelled')
    or v_new_status not in ('under_review', 'returned', 'approved', 'cancelled')
    or v_new_status = v_expected_status
    or not (
      (v_expected_status = 'under_review'
        and v_new_status in ('returned', 'approved', 'cancelled'))
      or (v_expected_status = 'returned' and v_new_status = 'cancelled')
    )
  then
    raise exception 'A valid payout review status transition is required.';
  end if;
  if p_allowed_location_ids is not null
    and not (p_location_id = any(p_allowed_location_ids))
  then
    raise exception 'The payout review is outside your location scope.';
  end if;

  if v_subject_type = 'workforce' then
    perform 1
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = p_subject_id
    for update;
    if not found then
      raise exception 'The selected Workforce payout review is unavailable.';
    end if;
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  update public.workforce_payout_review_submissions review
  set status = v_new_status,
      updated_at = clock_timestamp()
  where review.company_id = p_company_id
    and review.subject_type = v_subject_type
    and review.subject_id = p_subject_id
    and review.location_id = p_location_id
    and review.period_start = p_period_start
    and review.period_end = p_period_end
    and review.status = v_expected_status
  returning review.id into v_review_id;
  get diagnostics v_changed = row_count;

  if v_changed <> 1 or v_review_id is null then
    raise exception 'The payout review state changed. Refresh the worksheet and try again.';
  end if;
  return jsonb_build_object(
    'review_id', v_review_id,
    'previous_status', v_expected_status,
    'status', v_new_status
  );
end
$function$;

revoke update on table public.workforce_payout_review_submissions from service_role;
revoke all on function public.workforce_send_payouts_for_review(
  uuid, uuid, date, date, jsonb, uuid[]
) from public, anon, authenticated, service_role;
revoke all on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.workforce_transition_payout_review_status(
  uuid, text, uuid, uuid, date, date, text, text, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_send_payouts_for_review(
  uuid, uuid, date, date, jsonb, uuid[]
) to service_role;
grant execute on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) to service_role;
grant execute on function public.workforce_transition_payout_review_status(
  uuid, text, uuid, uuid, date, date, text, text, uuid[]
) to service_role;

-- Replace the import wrapper. The retained importer already locks Workforce
-- rows and then the company mutex. While those locks are held, lock matching
-- publication rows, reject terminal reviews or in-flight sends, and
-- supersede every claimable stale notification before queue insertion.
-- Deliberately do not tuple-lock the joined review: the retained importer
-- already owns the company advisory mutex. A concurrent direct review update
-- may own its tuple while waiting for that mutex; after this transaction queues
-- and commits, its BEFORE trigger resumes and rejects the now-open refresh. If
-- the review acquired the mutex first, this import later observes its terminal
-- status and rolls back. Locking both here would invert those locks and deadlock.
create or replace function public.workforce_apply_payout_import(
  p_company_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch_id uuid;
  v_target record;
  v_latest record;
begin
  v_batch_id := public.workforce_apply_payout_import_without_publication_refresh(
    p_company_id,
    p_effective_from,
    p_effective_to,
    p_file_name,
    p_file_sha256,
    p_rows,
    p_actor_user_id,
    p_allowed_location_ids
  );

  for v_target in
    select distinct
      imported.workforce_id,
      imported.station_id,
      publication.period_start,
      publication.period_end
    from public.workforce_payout_import_rows imported
    join public.workforce_payout_publications publication
      on publication.company_id = p_company_id
     and publication.publication_kind = 'worksheet'
     and publication.workforce_id = imported.workforce_id
     and publication.station_id = imported.station_id
     and daterange(publication.period_start, publication.period_end, '[]')
       && daterange(imported.effective_from, imported.effective_to, '[]')
    where imported.company_id = p_company_id
      and imported.batch_id = v_batch_id
    order by imported.workforce_id, imported.station_id,
      publication.period_start, publication.period_end
  loop
    perform 1
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_target.workforce_id
      and publication.station_id = v_target.station_id
      and publication.period_start = v_target.period_start
      and publication.period_end = v_target.period_end
    order by publication.revision, publication.published_at, publication.id
    for update;

    select publication.id, publication.revision,
      publication.review_submission_id, review.status as review_status
    into strict v_latest
    from public.workforce_payout_publications publication
    join public.workforce_payout_review_submissions review
      on review.id = publication.review_submission_id
     and review.company_id = publication.company_id
     and review.subject_type = 'workforce'
     and review.subject_id = publication.workforce_id
     and review.location_id = publication.station_id
     and review.period_start = publication.period_start
     and review.period_end = publication.period_end
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_target.workforce_id
      and publication.station_id = v_target.station_id
      and publication.period_start = v_target.period_start
      and publication.period_end = v_target.period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1
    for update of publication;

    if v_latest.review_status in ('approved', 'cancelled') then
      raise exception 'Published payout inputs cannot be changed after its review is approved or cancelled.';
    end if;
    if exists (
      select 1
      from public.workforce_payout_publications publication
      where publication.company_id = p_company_id
        and publication.publication_kind = 'worksheet'
        and publication.workforce_id = v_target.workforce_id
        and publication.station_id = v_target.station_id
        and publication.period_start = v_target.period_start
        and publication.period_end = v_target.period_end
        and publication.notification_status = 'sending'
    ) then
      raise exception 'A notification for this payout is currently sending. Retry the edit after its delivery state is known.';
    end if;

    update public.workforce_payout_publications publication
    set notification_status = 'superseded',
        notification_error = case
          when publication.notification_status = 'uncertain'
            then coalesce(publication.notification_error, 'Superseded by a payout input revision after operator review.')
          else publication.notification_error
        end
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_target.workforce_id
      and publication.station_id = v_target.station_id
      and publication.period_start = v_target.period_start
      and publication.period_end = v_target.period_end
      and publication.notification_status in ('pending', 'failed', 'uncertain');

    insert into public.workforce_payout_publication_refresh_jobs (
      company_id, input_batch_id, workforce_id, station_id,
      period_start, period_end, base_publication_id, base_revision,
      requested_by, next_attempt_at
    ) values (
      p_company_id, v_batch_id, v_target.workforce_id, v_target.station_id,
      v_target.period_start, v_target.period_end, v_latest.id,
      v_latest.revision, p_actor_user_id, clock_timestamp()
    )
    on conflict (
      company_id, input_batch_id, workforce_id, station_id,
      period_start, period_end
    ) do nothing;
  end loop;

  return v_batch_id;
end
$function$;

create or replace function public.workforce_claim_payout_publication_refresh_jobs(
  p_limit integer,
  p_company_id uuid default null,
  p_batch_id uuid default null
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

  -- The route may run for 300 seconds and processes claimed groups serially.
  -- Keep a ten-minute lease (the route ceiling plus a five-minute drain and
  -- commit buffer) before reclaiming any claim. A crashed final attempt then
  -- becomes visible dead-letter work instead of remaining reclaimable forever.
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
    and (p_company_id is null or job.company_id = p_company_id)
    and (p_batch_id is null or job.input_batch_id = p_batch_id);

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
    where (p_company_id is null or job.company_id = p_company_id)
      and (p_batch_id is null or job.input_batch_id = p_batch_id)
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
    -- Freeze one batch before taking row leases. Concurrent callers that saw
    -- the same oldest batch can share only that batch via SKIP LOCKED; they
    -- cannot spill into unrelated newer batches in this invocation.
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

create or replace function public.workforce_fail_payout_publication_refresh_jobs(
  p_failures jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_failure jsonb;
  v_job_id uuid;
  v_claim_token uuid;
  v_error text;
  v_status text;
  v_next_attempt_at timestamptz;
  v_attempts integer;
  v_accepted integer := 0;
  v_retried integer := 0;
  v_failed integer := 0;
  v_stale integer := 0;
  v_states jsonb := '[]'::jsonb;
begin
  if p_failures is null or jsonb_typeof(p_failures) <> 'array'
    or jsonb_array_length(p_failures) < 1
    or jsonb_array_length(p_failures) > 100
  then
    raise exception 'Report between 1 and 100 payout publication refresh failures.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_failures) supplied
    where jsonb_typeof(supplied) <> 'object'
      or nullif(btrim(supplied ->> 'job_id'), '') is null
      or nullif(btrim(supplied ->> 'claim_token'), '') is null
      or nullif(btrim(supplied ->> 'error'), '') is null
  ) or exists (
    select 1
    from jsonb_array_elements(p_failures) supplied
    group by supplied ->> 'job_id'
    having count(*) > 1
  ) then
    raise exception 'Every unique refresh failure requires a job, claim token, and error.';
  end if;

  for v_failure in
    select supplied.value
    from jsonb_array_elements(p_failures) supplied(value)
    order by supplied.value ->> 'job_id'
  loop
    v_job_id := (v_failure ->> 'job_id')::uuid;
    v_claim_token := (v_failure ->> 'claim_token')::uuid;
    v_error := left(btrim(v_failure ->> 'error'), 2000);
    v_status := null;
    v_next_attempt_at := null;
    v_attempts := null;

    update public.workforce_payout_publication_refresh_jobs job
    set status = case
          when job.claim_attempts >= job.max_attempts then 'failed'
          else 'pending'
        end,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = case
          when job.claim_attempts >= job.max_attempts then null
          else clock_timestamp() + pg_catalog.make_interval(
            mins => least(30, pg_catalog.power(2::numeric, greatest(job.claim_attempts - 1, 0))::integer)
          )
        end,
        failed_at = case
          when job.claim_attempts >= job.max_attempts then clock_timestamp()
          else null
        end,
        last_error = v_error,
        updated_at = clock_timestamp()
    where job.id = v_job_id
      and job.status = 'processing'
      and job.claim_token = v_claim_token
    returning job.status, job.next_attempt_at, job.claim_attempts
    into v_status, v_next_attempt_at, v_attempts;

    if not found then
      v_stale := v_stale + 1;
      continue;
    end if;
    v_accepted := v_accepted + 1;
    if v_status = 'failed' then
      v_failed := v_failed + 1;
    else
      v_retried := v_retried + 1;
    end if;
    v_states := v_states || jsonb_build_array(jsonb_build_object(
      'job_id', v_job_id,
      'status', v_status,
      'claim_attempts', v_attempts,
      'next_attempt_at', v_next_attempt_at,
      'error', v_error
    ));
  end loop;

  return jsonb_build_object(
    'accepted', v_accepted,
    'retried', v_retried,
    'failed', v_failed,
    'stale', v_stale,
    'jobs', v_states
  );
end
$function$;

-- Failed work represents a committed input change whose published snapshot may
-- still be stale. Operators must explicitly replay it before review can reach
-- a terminal state; replay never rewrites the job's request/batch audit.
create or replace function public.workforce_replay_failed_payout_publication_refresh_jobs(
  p_job_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_requested integer;
  v_locked integer;
  v_replayed integer;
  v_job_ids jsonb;
begin
  v_requested := coalesce(cardinality(p_job_ids), 0);
  if v_requested < 1 or v_requested > 100
    or array_position(p_job_ids, null::uuid) is not null
  then
    raise exception 'Replay between 1 and 100 failed payout publication refresh jobs.';
  end if;
  if (
    select count(distinct supplied.job_id)
    from unnest(p_job_ids) supplied(job_id)
  ) <> v_requested then
    raise exception 'Each failed payout publication refresh job may be replayed only once per request.';
  end if;

  perform 1
  from public.workforce_payout_publication_refresh_jobs job
  where job.id = any(p_job_ids)
  order by job.id
  for update;
  get diagnostics v_locked = row_count;
  if v_locked <> v_requested then
    raise exception 'A failed payout publication refresh job is unavailable.';
  end if;
  if exists (
    select 1
    from public.workforce_payout_publication_refresh_jobs job
    where job.id = any(p_job_ids)
      and job.status <> 'failed'
  ) then
    raise exception 'Only failed payout publication refresh jobs can be replayed.';
  end if;

  with replayed as (
    update public.workforce_payout_publication_refresh_jobs job
    set status = 'pending',
        claim_attempts = 0,
        claim_token = null,
        claimed_at = null,
        next_attempt_at = clock_timestamp(),
        failed_at = null,
        last_error = null,
        completed_at = null,
        published_publication_id = null,
        updated_at = clock_timestamp()
    where job.id = any(p_job_ids)
    returning job.id
  )
  select count(*)::integer,
    coalesce(jsonb_agg(replayed.id order by replayed.id), '[]'::jsonb)
  into v_replayed, v_job_ids
  from replayed;

  return jsonb_build_object(
    'replayed', v_replayed,
    'job_ids', v_job_ids
  );
end
$function$;

-- A successful newer full snapshot covers every earlier input generation for
-- the same payout identity. Reconcile older dead letters to that immutable
-- publication so they retain an audited outcome without forcing a redundant
-- replay/revision. Failed generations newer than the successful anchor remain
-- failed and continue blocking terminal review decisions.
create or replace function public.reconcile_covered_workforce_payout_refresh_failures()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_anchor_created_at timestamptz;
  v_anchor_job_id uuid;
begin
  if new.publication_kind <> 'worksheet'
    or new.revision_source <> 'input_batch_refresh'
    or new.input_batch_id is null
  then
    return new;
  end if;

  select job.created_at, job.id
  into v_anchor_created_at, v_anchor_job_id
  from public.workforce_payout_publication_refresh_jobs job
  where job.company_id = new.company_id
    and job.input_batch_id = new.input_batch_id
    and job.workforce_id = new.workforce_id
    and job.station_id = new.station_id
    and job.period_start = new.period_start
    and job.period_end = new.period_end;

  if not found then
    raise exception 'The successful payout publication refresh has no queue audit anchor.';
  end if;

  update public.workforce_payout_publication_refresh_jobs job
  set status = 'completed',
      claim_token = null,
      claimed_at = coalesce(job.claimed_at, clock_timestamp()),
      next_attempt_at = null,
      failed_at = null,
      last_error = left(
        'Reconciled by newer successful publication ' || new.id::text
          || '. Previous dead-letter error: ' || coalesce(job.last_error, 'Unavailable.'),
        2000
      ),
      completed_at = clock_timestamp(),
      published_publication_id = new.id,
      updated_at = clock_timestamp()
  where job.company_id = new.company_id
    and job.workforce_id = new.workforce_id
    and job.station_id = new.station_id
    and job.period_start = new.period_start
    and job.period_end = new.period_end
    and job.status = 'failed'
    and (job.created_at, job.id) <= (v_anchor_created_at, v_anchor_job_id);

  return new;
end
$function$;

drop trigger if exists workforce_payout_publications_90_reconcile_refresh_failures
  on public.workforce_payout_publications;
create trigger workforce_payout_publications_90_reconcile_refresh_failures
after insert on public.workforce_payout_publications
for each row execute function public.reconcile_covered_workforce_payout_refresh_failures();

-- A zero/tombstone revision is allowed only when the prior visible row was a
-- synthetic input-only fallback. This prevents a missing mapped payout row
-- from being mistaken for an intentional CLEAR.
create or replace function public.workforce_payout_snapshot_is_input_only(
  p_snapshot jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case
    when jsonb_typeof(p_snapshot) <> 'object'
      or p_snapshot ->> 'schema_version' <> '2'
      or p_snapshot ->> 'source' <> 'workforce_payout_worksheet'
      or coalesce(p_snapshot #>> '{worksheet,row_id}', '') not like 'payout-input-%'
      or p_snapshot #>> '{worksheet,mapping_status}' <> 'Not required'
      or jsonb_typeof(p_snapshot -> 'lines') <> 'array'
      or jsonb_typeof(p_snapshot #> '{worksheet,payment_method_breakdown}') <> 'array'
      or jsonb_typeof(p_snapshot #> '{worksheet,production_breakdown}') <> 'array'
      or jsonb_typeof(p_snapshot #> '{worksheet,daily_breakdown}') <> 'array'
    then false
    else
      jsonb_array_length(p_snapshot #> '{worksheet,payment_method_breakdown}') = 0
      and jsonb_array_length(p_snapshot #> '{worksheet,production_breakdown}') = 0
      and jsonb_array_length(p_snapshot #> '{worksheet,daily_breakdown}') = 0
      and coalesce(p_snapshot #>> '{item,base_amount}', '') ~ '^-?0([.]0+)?$'
      and coalesce(p_snapshot #>> '{item,work_days}', '') ~ '^-?0([.]0+)?$'
      and not exists (
        select 1
        from jsonb_array_elements(p_snapshot -> 'lines') line
        where coalesce(line ->> 'source_type', '') not in ('additional_payment', 'deduction')
      )
  end
$function$;

create or replace function public.guard_workforce_payout_refresh_revision()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_previous jsonb;
begin
  if new.revision_source <> 'input_batch_refresh'
    or new.snapshot #>> '{worksheet,tombstone_reason}' is distinct from 'input_values_cleared'
  then
    return new;
  end if;

  select publication.snapshot
  into v_previous
  from public.workforce_payout_publications publication
  where publication.id = new.supersedes_publication_id
    and publication.company_id = new.company_id
    and publication.workforce_id = new.workforce_id
    and publication.station_id = new.station_id
    and publication.period_start = new.period_start
    and publication.period_end = new.period_end;

  if not found or not public.workforce_payout_snapshot_is_input_only(v_previous) then
    raise exception 'A missing mapped payout cannot be replaced by an input-clear tombstone.';
  end if;
  if new.snapshot #>> '{item,worker_name}' is distinct from v_previous #>> '{item,worker_name}'
    or new.snapshot #>> '{item,dropx_id}' is distinct from v_previous #>> '{item,dropx_id}'
    or new.snapshot #>> '{item,station_code}' is distinct from v_previous #>> '{item,station_code}'
    or new.snapshot #>> '{item,designation}' is distinct from v_previous #>> '{item,designation}'
    or new.snapshot #> '{item,provider_member_ids}' is distinct from v_previous #> '{item,provider_member_ids}'
    or new.snapshot #>> '{worksheet,row_id}' is distinct from v_previous #>> '{worksheet,row_id}'
    or new.snapshot -> 'lines' is distinct from '[]'::jsonb
    or new.snapshot #> '{worksheet,payment_method_breakdown}' is distinct from '[]'::jsonb
    or new.snapshot #> '{worksheet,production_breakdown}' is distinct from '[]'::jsonb
    or new.snapshot #> '{worksheet,additional_payment_breakdown}' is distinct from '[]'::jsonb
    or new.snapshot #> '{worksheet,deduction_breakdown}' is distinct from '[]'::jsonb
    or new.snapshot #> '{worksheet,daily_breakdown}' is distinct from '[]'::jsonb
    or exists (
      select 1
      from jsonb_each(new.snapshot -> 'item') item
      where item.key in (
        'work_days', 'base_amount', 'incentive_amount', 'adjustment_amount',
        'deduction_amount', 'gross_amount', 'net_amount'
      )
        and (jsonb_typeof(item.value) <> 'number' or item.value #>> '{}' !~ '^-?0([.]0+)?$')
    )
  then
    raise exception 'The input-clear payout tombstone is invalid.';
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_publications_10_refresh_revision_guard
  on public.workforce_payout_publications;
create trigger workforce_payout_publications_10_refresh_revision_guard
before insert on public.workforce_payout_publications
for each row execute function public.guard_workforce_payout_refresh_revision();

-- Wrap the already-deployed revision writer. The retained implementation owns
-- lock ordering and immutable insertion; this wrapper supplies lease tokens to
-- the state trigger above without changing the public RPC signature.
alter function public.workforce_apply_payout_publication_input_revisions(
  uuid, date, date, text, uuid, jsonb
)
  rename to workforce_apply_payout_publication_input_revisions_without_hardening;

revoke all on function public.workforce_apply_payout_publication_input_revisions_without_hardening(
  uuid, date, date, text, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.workforce_apply_payout_publication_input_revisions(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_dependency_hash text,
  p_actor_user_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) < 1
    or exists (
      select 1
      from jsonb_array_elements(p_items) supplied
      where nullif(btrim(supplied ->> 'claim_token'), '') is null
    )
  then
    raise exception 'Every payout publication revision requires its current claim token.';
  end if;

  perform pg_catalog.set_config(
    'app.workforce_payout_refresh_claims',
    p_items::text,
    true
  );
  v_result := public.workforce_apply_payout_publication_input_revisions_without_hardening(
    p_company_id,
    p_period_start,
    p_period_end,
    p_expected_dependency_hash,
    p_actor_user_id,
    p_items
  );
  return v_result;
end
$function$;

comment on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) is
  'Atomically imports payout inputs, rejects terminal reviews or sending notifications, supersedes claimable notification rows, and enqueues immutable publication refresh work.';
comment on function public.workforce_send_payouts_for_review(
  uuid, uuid, date, date, jsonb, uuid[]
) is
  'Lock-ordered service boundary for payout review submission/resubmission. Workforce rows and the company mutex are acquired before any existing review row is updated.';
comment on function public.workforce_send_payouts_for_review_without_lock_order(
  uuid, uuid, date, date, jsonb, uuid[]
) is
  'Internal retained payout review submission implementation; callable only through the lock-ordered wrapper.';
comment on function public.workforce_transition_payout_review_status(
  uuid, text, uuid, uuid, date, date, text, text, uuid[]
) is
  'Optimistically applies reviewer decisions under Workforce then company lock order. Resubmission remains exclusive to snapshot/publication RPCs.';
comment on function public.workforce_claim_payout_publication_refresh_jobs(integer, uuid, uuid) is
  'Claims at most one oldest eligible input batch per invocation with opaque ten-minute lease tokens, strict identity ordering, bounded attempts, and SKIP LOCKED. A supplied batch ID restricts claims to that batch. Ten minutes covers the 300-second route ceiling plus drain/commit time.';
comment on function public.workforce_fail_payout_publication_refresh_jobs(jsonb) is
  'Token-validates refresh failures, applies bounded exponential backoff, and dead-letters work after its attempt budget.';
comment on function public.workforce_replay_failed_payout_publication_refresh_jobs(uuid[]) is
  'Explicitly requeues validated dead-letter refresh jobs while preserving their original request and input-batch audit.';
comment on function public.reconcile_covered_workforce_payout_refresh_failures() is
  'Marks older/equal failed queue generations completed against a newer successful immutable publication; newer failures remain unresolved.';
comment on function public.workforce_apply_payout_publication_input_revisions(
  uuid, date, date, text, uuid, jsonb
) is
  'Lease-token wrapper around the immutable refresh revision writer; stale workers cannot complete reclaimed jobs.';

revoke all on function public.guard_workforce_payout_refresh_job_state(),
  public.preserve_workforce_payout_review_submission_audit(),
  public.lock_workforce_attendance_policy_review_submission(),
  public.guard_workforce_payout_review_status_transition(),
  public.workforce_payout_snapshot_is_input_only(jsonb),
  public.guard_workforce_payout_refresh_revision(),
  public.reconcile_covered_workforce_payout_refresh_failures(),
  public.workforce_apply_payout_import(uuid,date,date,text,text,jsonb,uuid,uuid[]),
  public.workforce_claim_payout_publication_refresh_jobs(integer,uuid,uuid),
  public.workforce_fail_payout_publication_refresh_jobs(jsonb),
  public.workforce_replay_failed_payout_publication_refresh_jobs(uuid[]),
  public.workforce_apply_payout_publication_input_revisions(uuid,date,date,text,uuid,jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.workforce_apply_payout_import(
  uuid,date,date,text,text,jsonb,uuid,uuid[]
) to service_role;
grant execute on function public.workforce_claim_payout_publication_refresh_jobs(
  integer,uuid,uuid
) to service_role;
grant execute on function public.workforce_fail_payout_publication_refresh_jobs(jsonb)
  to service_role;
grant execute on function public.workforce_replay_failed_payout_publication_refresh_jobs(uuid[])
  to service_role;
grant execute on function public.workforce_apply_payout_publication_input_revisions(
  uuid,date,date,text,uuid,jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
