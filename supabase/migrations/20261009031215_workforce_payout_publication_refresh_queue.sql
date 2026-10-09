begin;

-- Published worksheet snapshots remain immutable. Input changes are recorded as
-- durable refresh work and become visible in DropX One only after a new
-- publication revision has been inserted atomically.
alter table public.workforce_payout_publications
  add column revision_source text not null default 'initial',
  add column input_batch_id uuid references public.workforce_payout_import_batches(id) on delete restrict,
  add column supersedes_publication_id uuid references public.workforce_payout_publications(id) on delete restrict;

alter table public.workforce_payout_publications
  add constraint workforce_payout_publications_revision_source_check
    check (revision_source in ('initial', 'input_batch_refresh')),
  add constraint workforce_payout_publications_revision_source_shape_check
    check (
      (
        revision_source = 'initial'
        and input_batch_id is null
        and supersedes_publication_id is null
      )
      or (
        revision_source = 'input_batch_refresh'
        and input_batch_id is not null
        and supersedes_publication_id is not null
      )
    );

create index workforce_payout_publications_input_batch_idx
  on public.workforce_payout_publications (input_batch_id)
  where input_batch_id is not null;
create index workforce_payout_publications_supersedes_idx
  on public.workforce_payout_publications (supersedes_publication_id)
  where supersedes_publication_id is not null;

comment on column public.workforce_payout_publications.revision_source is
  'Immutable origin of this publication revision. input_batch_refresh revisions are silent replacements generated after an audited payout input batch.';
comment on column public.workforce_payout_publications.input_batch_id is
  'Committed payout input batch that caused this immutable publication revision, when revision_source is input_batch_refresh.';
comment on column public.workforce_payout_publications.supersedes_publication_id is
  'Previous immutable publication for the same Workforce, station, and payout period.';

create table public.workforce_payout_publication_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  input_batch_id uuid not null references public.workforce_payout_import_batches(id) on delete restrict,
  workforce_id uuid not null,
  station_id uuid not null,
  period_start date not null,
  period_end date not null,
  base_publication_id uuid not null references public.workforce_payout_publications(id) on delete restrict,
  base_revision integer not null,
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending',
  claim_attempts integer not null default 0,
  claimed_at timestamptz,
  last_error text,
  completed_at timestamptz,
  published_publication_id uuid references public.workforce_payout_publications(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_publication_refresh_jobs_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce (company_id, id)
    on delete restrict,
  constraint workforce_payout_publication_refresh_jobs_station_company_fk
    foreign key (company_id, station_id)
    references public.stations (company_id, id)
    on delete restrict,
  constraint workforce_payout_publication_refresh_jobs_period_check
    check (period_end >= period_start),
  constraint workforce_payout_publication_refresh_jobs_base_revision_check
    check (base_revision > 0),
  constraint workforce_payout_publication_refresh_jobs_status_check
    check (status in ('pending', 'processing', 'completed')),
  constraint workforce_payout_publication_refresh_jobs_claim_attempts_check
    check (claim_attempts >= 0),
  constraint workforce_payout_publication_refresh_jobs_last_error_check
    check (last_error is null or length(last_error) <= 2000),
  constraint workforce_payout_publication_refresh_jobs_state_shape_check
    check (
      (
        status = 'pending'
        and claimed_at is null
        and completed_at is null
        and published_publication_id is null
      )
      or (
        status = 'processing'
        and claimed_at is not null
        and completed_at is null
        and published_publication_id is null
      )
      or (
        status = 'completed'
        and claimed_at is not null
        and completed_at is not null
        and published_publication_id is not null
      )
    ),
  constraint workforce_payout_publication_refresh_jobs_batch_identity_unique
    unique (
      company_id, input_batch_id, workforce_id, station_id,
      period_start, period_end
    )
);

create index workforce_payout_publication_refresh_jobs_claim_idx
  on public.workforce_payout_publication_refresh_jobs (created_at, id)
  where status in ('pending', 'processing');
create index workforce_payout_publication_refresh_jobs_company_claim_idx
  on public.workforce_payout_publication_refresh_jobs
  (company_id, input_batch_id, created_at, id)
  where status in ('pending', 'processing');
create index workforce_payout_refresh_jobs_open_identity_idx
  on public.workforce_payout_publication_refresh_jobs
  (company_id, workforce_id, station_id, period_start, period_end, created_at, id)
  where status in ('pending', 'processing');
create index workforce_payout_publication_refresh_jobs_input_batch_idx
  on public.workforce_payout_publication_refresh_jobs (input_batch_id);
create index workforce_payout_publication_refresh_jobs_base_publication_idx
  on public.workforce_payout_publication_refresh_jobs (base_publication_id);
create index workforce_payout_refresh_jobs_published_publication_idx
  on public.workforce_payout_publication_refresh_jobs (published_publication_id)
  where published_publication_id is not null;
create index workforce_payout_publication_refresh_jobs_requested_by_idx
  on public.workforce_payout_publication_refresh_jobs (requested_by)
  where requested_by is not null;

comment on table public.workforce_payout_publication_refresh_jobs is
  'Service-only durable queue. A committed payout input batch creates one job for each already-published Workforce/station/publication-period identity affected by that batch.';

alter table public.workforce_payout_publication_refresh_jobs enable row level security;
alter table public.workforce_payout_publication_refresh_jobs force row level security;
revoke all on table public.workforce_payout_publication_refresh_jobs
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_publication_refresh_jobs to service_role;
grant update (status, claimed_at, last_error, updated_at)
  on table public.workforce_payout_publication_refresh_jobs to service_role;

create policy workforce_payout_publication_refresh_jobs_service_select
  on public.workforce_payout_publication_refresh_jobs
  for select
  to service_role
  using (true);

create policy workforce_payout_publication_refresh_jobs_service_failure_reset
  on public.workforce_payout_publication_refresh_jobs
  for update
  to service_role
  using (true)
  with check (true);

-- Preserve the proven importer, including its approved/paid guards, and place a
-- transactional queue boundary around it without changing the public RPC
-- signature used by the application.
alter function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
)
  rename to workforce_apply_payout_import_without_publication_refresh;

revoke all on function public.workforce_apply_payout_import_without_publication_refresh(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) from public, anon, authenticated, service_role;

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

  insert into public.workforce_payout_publication_refresh_jobs (
    company_id,
    input_batch_id,
    workforce_id,
    station_id,
    period_start,
    period_end,
    base_publication_id,
    base_revision,
    requested_by
  )
  select distinct
    p_company_id,
    v_batch_id,
    imported.workforce_id,
    imported.station_id,
    publication.period_start,
    publication.period_end,
    publication.id,
    publication.revision,
    p_actor_user_id
  from public.workforce_payout_import_rows imported
  cross join lateral (
    select distinct on (existing.period_start, existing.period_end)
      existing.id, existing.period_start, existing.period_end, existing.revision
    from public.workforce_payout_publications existing
    where existing.company_id = p_company_id
      and existing.publication_kind = 'worksheet'
      and existing.workforce_id = imported.workforce_id
      and existing.station_id = imported.station_id
      and daterange(existing.period_start, existing.period_end, '[]')
        && daterange(imported.effective_from, imported.effective_to, '[]')
    order by
      existing.period_start,
      existing.period_end,
      existing.revision desc,
      existing.published_at desc,
      existing.id desc
  ) publication
  where imported.company_id = p_company_id
    and imported.batch_id = v_batch_id
  on conflict (
    company_id, input_batch_id, workforce_id, station_id,
    period_start, period_end
  ) do nothing;

  return v_batch_id;
end
$function$;

comment on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) is
  'Atomically applies an audited Workforce payout input batch with the existing approved/paid guards and enqueues exact already-published Workforce/station/period identities for immutable revision refresh.';

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

  return query
  with eligible as (
    select
      job.id,
      job.created_at,
      row_number() over (
        partition by job.company_id, job.workforce_id, job.station_id,
          job.period_start, job.period_end
        order by job.created_at, job.id
      ) as identity_order
    from public.workforce_payout_publication_refresh_jobs job
    where (p_company_id is null or job.company_id = p_company_id)
      and (
        p_batch_id is null
        or exists (
          select 1
          from public.workforce_payout_publication_refresh_jobs requested
          where requested.input_batch_id = p_batch_id
            and requested.company_id = job.company_id
            and requested.workforce_id = job.workforce_id
            and requested.station_id = job.station_id
            and requested.period_start = job.period_start
            and requested.period_end = job.period_end
            and requested.status in ('pending', 'processing')
        )
      )
      and (
        job.status = 'pending'
        or (
          job.status = 'processing'
          and job.claimed_at < clock_timestamp() - interval '5 minutes'
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
          and active.claimed_at >= clock_timestamp() - interval '5 minutes'
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
  ), candidates as (
    select job.id
    from public.workforce_payout_publication_refresh_jobs job
    join eligible on eligible.id = job.id and eligible.identity_order = 1
    order by eligible.created_at, job.id
    limit p_limit
    for update of job skip locked
  ), claimed as (
    update public.workforce_payout_publication_refresh_jobs job
    set status = 'processing',
        claim_attempts = job.claim_attempts + 1,
        claimed_at = clock_timestamp(),
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

comment on function public.workforce_claim_payout_publication_refresh_jobs(integer, uuid, uuid) is
  'Claims pending or stale payout publication refresh jobs with SKIP LOCKED. A batch-scoped request returns the earliest open generation for each identity in that batch and cannot leapfrog a predecessor.';

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
  v_item jsonb;
  v_job_id uuid;
  v_workforce_id uuid;
  v_station_id uuid;
  v_snapshot jsonb;
  v_snapshot_hash text;
  v_current_dependency_hash text;
  v_job public.workforce_payout_publication_refresh_jobs%rowtype;
  v_previous public.workforce_payout_publications%rowtype;
  v_revision_batch_id uuid;
  v_revision_actor_user_id uuid;
  v_publication_id uuid;
  v_review_id uuid;
  v_next_revision integer;
  v_item_count integer;
  v_locked_count integer;
  v_completed integer := 0;
  v_completed_for_identity integer;
  v_published integer := 0;
  v_publication_ids jsonb := '[]'::jsonb;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and publisher are required.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Payout publication input revisions require one complete calendar month.';
  end if;
  if nullif(btrim(p_expected_dependency_hash), '') is null then
    raise exception 'The current payout worksheet dependency hash is required.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Payout publication revision items must be an array.';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 100 then
    raise exception 'Apply between 1 and 100 payout publication revisions.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    where jsonb_typeof(selected) <> 'object'
      or nullif(btrim(selected ->> 'job_id'), '') is null
      or nullif(btrim(selected ->> 'workforce_id'), '') is null
      or nullif(btrim(selected ->> 'station_id'), '') is null
      or jsonb_typeof(selected -> 'snapshot') <> 'object'
      or nullif(btrim(selected ->> 'snapshot_hash'), '') is null
  ) then
    raise exception 'Every payout publication revision item requires a job, Workforce member, station, snapshot, and snapshot hash.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by (selected ->> 'job_id')::uuid
    having count(*) > 1
  ) then
    raise exception 'The same payout publication refresh job was supplied more than once.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by (selected ->> 'workforce_id')::uuid, (selected ->> 'station_id')::uuid
    having count(*) > 1
  ) then
    raise exception 'Submit at most one refresh job for each Workforce and station in a payout period.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'The payout publication revision publisher is unavailable.';
  end if;

  -- Match the established payout lock order: Workforce rows first, then the
  -- shared company mutex. This serializes imports, publication, and revisions.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select distinct (selected ->> 'workforce_id')::uuid
      from jsonb_array_elements(p_items) selected
    )
  order by workforce.id
  for update;

  if (
    select count(*)
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.deleted_at is null
      and workforce.migration_state <> 'reclassified'
      and workforce.id in (
        select distinct (selected ->> 'workforce_id')::uuid
        from jsonb_array_elements(p_items) selected
      )
  ) <> (
    select count(distinct (selected ->> 'workforce_id')::uuid)
    from jsonb_array_elements(p_items) selected
  ) then
    raise exception 'A selected Workforce payout is no longer available.';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- Lock all jobs in a deterministic order before validating their state.
  perform 1
  from public.workforce_payout_publication_refresh_jobs job
  where job.company_id = p_company_id
    and job.id in (
      select (selected ->> 'job_id')::uuid
      from jsonb_array_elements(p_items) selected
    )
  order by job.id
  for update;

  get diagnostics v_locked_count = row_count;
  if v_locked_count <> v_item_count then
    raise exception 'A payout publication refresh job is unavailable or outside the company scope.';
  end if;

  v_current_dependency_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id,
    p_period_start,
    p_period_end
  );
  if v_current_dependency_hash is distinct from p_expected_dependency_hash then
    raise exception 'Payout inputs changed after these refresh snapshots were calculated. Reclaim and recalculate the jobs.';
  end if;

  for v_item in
    select selected.value
    from jsonb_array_elements(p_items) selected(value)
    order by selected.value ->> 'job_id'
  loop
    v_job_id := (v_item ->> 'job_id')::uuid;
    v_workforce_id := (v_item ->> 'workforce_id')::uuid;
    v_station_id := (v_item ->> 'station_id')::uuid;
    v_snapshot := v_item -> 'snapshot';
    v_snapshot_hash := lower(btrim(v_item ->> 'snapshot_hash'));

    select job.*
    into strict v_job
    from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.id = v_job_id;

    if v_job.status <> 'processing'
      or v_job.period_start <> p_period_start
      or v_job.period_end <> p_period_end
      or v_job.workforce_id <> v_workforce_id
      or v_job.station_id <> v_station_id
    then
      raise exception 'A payout publication refresh job changed or does not match its supplied identity and period.';
    end if;
    if not exists (
      select 1
      from public.workforce_payout_import_batches batch
      where batch.id = v_job.input_batch_id
        and batch.company_id = p_company_id
        and batch.status = 'committed'
    ) then
      raise exception 'The payout publication refresh job does not reference a committed input batch.';
    end if;
    if v_snapshot ->> 'schema_version' is distinct from '2'
      or v_snapshot ->> 'source' is distinct from 'workforce_payout_worksheet'
      or v_snapshot ->> 'dependency_hash' is distinct from p_expected_dependency_hash
      or v_snapshot #>> '{run,period_start}' is distinct from p_period_start::text
      or v_snapshot #>> '{run,period_end}' is distinct from p_period_end::text
      or v_snapshot #>> '{item,workforce_id}' is distinct from v_workforce_id::text
      or v_snapshot #>> '{item,station_id}' is distinct from v_station_id::text
      or v_snapshot_hash !~ '^[0-9a-f]{64}$'
    then
      raise exception 'A payout publication refresh snapshot is invalid or stale.';
    end if;

    select publication.*
    into v_previous
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.workforce_id = v_workforce_id
      and publication.station_id = v_station_id
      and publication.publication_kind = 'worksheet'
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1
    for update;

    if not found then
      raise exception 'The published payout targeted by a refresh job is no longer available.';
    end if;

    -- A claimed predecessor may cover later batches that committed before the
    -- caller calculated this globally versioned snapshot. Link the revision to
    -- the newest open generation; every open generation for this exact
    -- identity is completed against the same immutable publication below.
    select refresh.input_batch_id, coalesce(refresh.requested_by, p_actor_user_id)
    into v_revision_batch_id, v_revision_actor_user_id
    from public.workforce_payout_publication_refresh_jobs refresh
    where refresh.company_id = p_company_id
      and refresh.workforce_id = v_workforce_id
      and refresh.station_id = v_station_id
      and refresh.period_start = p_period_start
      and refresh.period_end = p_period_end
      and refresh.status in ('pending', 'processing')
    order by refresh.created_at desc, refresh.id desc
    limit 1;

    if v_revision_batch_id is null or v_revision_actor_user_id is null then
      raise exception 'The payout publication refresh generation is no longer open.';
    end if;
    if not exists (
      select 1 from auth.users actor where actor.id = v_revision_actor_user_id
    ) then
      raise exception 'The newest payout input revision publisher is unavailable.';
    end if;

    v_review_id := null;
    update public.workforce_payout_review_submissions review
    set status = case when review.status = 'returned' then 'under_review' else review.status end,
        calculation_snapshot = v_snapshot,
        submitted_by = v_revision_actor_user_id,
        submitted_at = case when review.status = 'returned' then clock_timestamp() else review.submitted_at end,
        updated_at = clock_timestamp()
    where review.id = v_previous.review_submission_id
      and review.company_id = p_company_id
      and review.subject_type = 'workforce'
      and review.subject_id = v_workforce_id
      and review.location_id = v_station_id
      and review.period_start = p_period_start
      and review.period_end = p_period_end
      and review.status in ('under_review', 'returned')
    returning review.id into v_review_id;

    if v_review_id is null then
      raise exception 'Approved or cancelled payout reviews cannot be silently revised.';
    end if;

    select coalesce(max(publication.revision), 0) + 1
    into v_next_revision
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.workforce_id = v_workforce_id
      and publication.publication_kind = 'worksheet'
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;

    -- Never allow an older queued notification to deliver stale values after
    -- the silent revision is committed.
    update public.workforce_payout_publications publication
    set notification_status = 'superseded'
    where publication.company_id = p_company_id
      and publication.workforce_id = v_workforce_id
      and publication.station_id = v_station_id
      and publication.publication_kind = 'worksheet'
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
      and publication.notification_status in ('pending', 'failed');

    insert into public.workforce_payout_publications (
      company_id,
      payroll_run_id,
      workforce_id,
      station_id,
      revision,
      snapshot,
      published_by,
      published_at,
      review_until,
      notify_at,
      source_calculated_at,
      notification_status,
      review_submission_id,
      period_start,
      period_end,
      snapshot_hash,
      dependency_hash,
      notification_config_snapshot,
      publication_kind,
      revision_source,
      input_batch_id,
      supersedes_publication_id
    ) values (
      p_company_id,
      null,
      v_workforce_id,
      v_station_id,
      v_next_revision,
      v_snapshot,
      v_revision_actor_user_id,
      clock_timestamp(),
      v_previous.review_until,
      v_previous.notify_at,
      clock_timestamp(),
      'disabled',
      v_review_id,
      p_period_start,
      p_period_end,
      v_snapshot_hash,
      p_expected_dependency_hash,
      jsonb_set(
        jsonb_set(
          coalesce(v_previous.notification_config_snapshot, '{}'::jsonb),
          '{app_notification_enabled}',
          'false'::jsonb,
          true
        ),
        '{whatsapp_notification_enabled}',
        'false'::jsonb,
        true
      ) || jsonb_build_object('silent_revision', true),
      'worksheet',
      'input_batch_refresh',
      v_revision_batch_id,
      v_previous.id
    )
    returning id into v_publication_id;

    update public.workforce_payout_publication_refresh_jobs job
    set status = 'completed',
        claimed_at = coalesce(job.claimed_at, clock_timestamp()),
        last_error = null,
        completed_at = clock_timestamp(),
        published_publication_id = v_publication_id,
        updated_at = clock_timestamp()
    where job.company_id = p_company_id
      and job.workforce_id = v_workforce_id
      and job.station_id = v_station_id
      and job.period_start = p_period_start
      and job.period_end = p_period_end
      and job.status in ('pending', 'processing');

    get diagnostics v_completed_for_identity = row_count;
    if v_completed_for_identity < 1 then
      raise exception 'The payout publication refresh job could not be completed.';
    end if;

    v_completed := v_completed + v_completed_for_identity;
    v_published := v_published + 1;
    v_publication_ids := v_publication_ids || jsonb_build_array(v_publication_id);
    v_review_id := null;
  end loop;

  return jsonb_build_object(
    'completed', v_completed,
    'published', v_published,
    'publication_ids', v_publication_ids
  );
end
$function$;

comment on function public.workforce_apply_payout_publication_input_revisions(
  uuid, date, date, text, uuid, jsonb
) is
  'Atomically validates the current global payout dependency hash, inserts immutable N+1 worksheet snapshots, coalesces every open input generation covered by each current snapshot, and completes those jobs without queuing duplicate notifications.';

revoke all on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) from public, anon, authenticated, service_role;
revoke all on function public.workforce_claim_payout_publication_refresh_jobs(
  integer, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.workforce_apply_payout_publication_input_revisions(
  uuid, date, date, text, uuid, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) to service_role;
grant execute on function public.workforce_claim_payout_publication_refresh_jobs(
  integer, uuid, uuid
) to service_role;
grant execute on function public.workforce_apply_payout_publication_input_revisions(
  uuid, date, date, text, uuid, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
