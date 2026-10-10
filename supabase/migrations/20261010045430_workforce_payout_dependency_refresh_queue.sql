begin;

-- Payout input imports were the first mutable source allowed to revise an
-- already-published worksheet, so the original queue used input_batch_id as
-- both provenance and scheduling generation. ADVANCE and payment-recovery
-- deductions are different audited sources. Give every refresh generation its
-- own source/request identity instead of manufacturing a fake import batch.
alter table public.workforce_payout_publication_refresh_jobs
  add column refresh_source text not null default 'input_batch',
  add column refresh_request_id uuid;

update public.workforce_payout_publication_refresh_jobs
set refresh_request_id = input_batch_id
where refresh_request_id is null;

-- Keep the established import wrapper and administrative replay fixtures
-- compatible: their existing INSERT statements provide input_batch_id, while
-- this trigger fills the equivalent source-neutral generation identifier.
create or replace function public.prepare_workforce_payout_publication_refresh_job()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.refresh_source = 'input_batch' then
    if new.input_batch_id is null then
      raise exception 'An input-batch payout refresh requires payout-import provenance.';
    end if;
    new.refresh_request_id := new.input_batch_id;
  elsif new.refresh_source = 'payout_dependency' then
    if new.input_batch_id is not null then
      raise exception 'A payout dependency refresh cannot use payout-import provenance.';
    end if;
    new.refresh_request_id := coalesce(new.refresh_request_id, gen_random_uuid());
  else
    raise exception 'The payout publication refresh source is invalid.';
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_publication_refresh_jobs_00_prepare
  on public.workforce_payout_publication_refresh_jobs;
create trigger workforce_payout_publication_refresh_jobs_00_prepare
before insert on public.workforce_payout_publication_refresh_jobs
for each row execute function public.prepare_workforce_payout_publication_refresh_job();

alter table public.workforce_payout_publication_refresh_jobs
  alter column refresh_request_id set not null,
  alter column input_batch_id drop not null,
  add constraint workforce_payout_refresh_jobs_source_check
    check (refresh_source in ('input_batch', 'payout_dependency')),
  add constraint workforce_payout_refresh_jobs_source_shape_check
    check (
      (
        refresh_source = 'input_batch'
        and input_batch_id is not null
        and refresh_request_id = input_batch_id
      )
      or (
        refresh_source = 'payout_dependency'
        and input_batch_id is null
      )
    );

alter table public.workforce_payout_publication_refresh_jobs
  drop constraint workforce_payout_publication_refresh_jobs_batch_identity_unique,
  add constraint workforce_payout_refresh_jobs_request_identity_unique
    unique (
      company_id, refresh_request_id, workforce_id, station_id,
      period_start, period_end
    );

create index workforce_payout_refresh_jobs_request_idx
  on public.workforce_payout_publication_refresh_jobs
  (company_id, refresh_request_id, created_at, id);

comment on column public.workforce_payout_publication_refresh_jobs.refresh_source is
  'Audited reason for the immutable revision: input_batch or a non-import payout_dependency change.';
comment on column public.workforce_payout_publication_refresh_jobs.refresh_request_id is
  'Queue generation identity. Import jobs reuse input_batch_id; dependency changes receive an independent UUID.';

-- Carry the generalized provenance into each immutable publication revision.
alter table public.workforce_payout_publications
  add column refresh_request_id uuid;

-- This is a one-time provenance backfill, not a financial snapshot mutation.
-- The immutable-row trigger intentionally rejects every ordinary column
-- update, so suspend only that exact trigger inside this migration transaction.
alter table public.workforce_payout_publications
  disable trigger workforce_payout_publications_00_immutable;
update public.workforce_payout_publications
set refresh_request_id = input_batch_id
where revision_source = 'input_batch_refresh'
  and refresh_request_id is null;
alter table public.workforce_payout_publications
  enable trigger workforce_payout_publications_00_immutable;

alter table public.workforce_payout_publications
  drop constraint workforce_payout_publications_revision_source_check,
  drop constraint workforce_payout_publications_revision_source_shape_check,
  add constraint workforce_payout_publications_revision_source_check
    check (revision_source in (
      'initial', 'input_batch_refresh', 'mapping_relock', 'dependency_refresh'
    )),
  add constraint workforce_payout_publications_revision_source_shape_check
    check (
      (
        revision_source = 'initial'
        and input_batch_id is null
        and refresh_request_id is null
        and supersedes_publication_id is null
        and mapping_relock_id is null
      )
      or (
        revision_source = 'input_batch_refresh'
        and input_batch_id is not null
        and refresh_request_id = input_batch_id
        and supersedes_publication_id is not null
      )
      or (
        revision_source = 'mapping_relock'
        and input_batch_id is null
        and refresh_request_id is null
        and mapping_relock_id is not null
      )
      or (
        revision_source = 'dependency_refresh'
        and input_batch_id is null
        and refresh_request_id is not null
        and supersedes_publication_id is not null
      )
    );

create index workforce_payout_publications_refresh_request_idx
  on public.workforce_payout_publications (refresh_request_id)
  where refresh_request_id is not null;

comment on column public.workforce_payout_publications.refresh_request_id is
  'Audited refresh generation that produced this immutable revision; independent from payout-import provenance.';

-- Queue every actual system-managed deduction mutation against every latest
-- worksheet publication whose period overlaps the changed value. Identical
-- retries do not reach this trigger because the canonical recovery RPC exits
-- before writing an unchanged plan.
create or replace function public.enqueue_workforce_payout_dependency_refresh(
  p_company_id uuid,
  p_workforce_id uuid,
  p_station_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_requested_by uuid
)
returns integer
language plpgsql
set search_path = ''
as $function$
declare
  -- Every material dependency write in one database transaction belongs to
  -- one refresh generation. A later transaction always receives a different
  -- generation, even while the previous job is pending or processing.
  v_request_id uuid := md5(
    'workforce_payout_dependency:' || txid_current()::text
  )::uuid;
  v_inserted integer := 0;
begin
  if p_company_id is null or p_workforce_id is null or p_station_id is null
    or p_effective_from is null or p_effective_to is null
    or p_effective_to < p_effective_from
  then
    raise exception 'A payout dependency refresh requires company, Workforce, location, and a valid effective period.';
  end if;

  insert into public.workforce_payout_publication_refresh_jobs (
    company_id,
    input_batch_id,
    refresh_source,
    refresh_request_id,
    workforce_id,
    station_id,
    period_start,
    period_end,
    base_publication_id,
    base_revision,
    requested_by,
    next_attempt_at
  )
  select
    p_company_id,
    null,
    'payout_dependency',
    v_request_id,
    p_workforce_id,
    p_station_id,
    latest.period_start,
    latest.period_end,
    latest.id,
    latest.revision,
    coalesce(p_requested_by, latest.published_by),
    clock_timestamp()
  from (
    select distinct on (publication.period_start, publication.period_end)
      publication.id,
      publication.period_start,
      publication.period_end,
      publication.revision,
      publication.published_by
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = p_workforce_id
      and publication.station_id = p_station_id
      and daterange(publication.period_start, publication.period_end, '[]')
        && daterange(p_effective_from, p_effective_to, '[]')
    order by publication.period_start, publication.period_end,
      publication.revision desc, publication.published_at desc, publication.id desc
  ) latest
  on conflict (
    company_id, refresh_request_id, workforce_id, station_id,
    period_start, period_end
  ) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$function$;

create or replace function public.queue_workforce_payout_deduction_refresh()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_old_relevant boolean := false;
  v_new_relevant boolean := false;
  v_identity_changed boolean := false;
begin
  if tg_op <> 'INSERT' then
    v_old_relevant := old.source_type in ('advance_register', 'payment_recovery');
  end if;
  if tg_op <> 'DELETE' then
    v_new_relevant := new.source_type in ('advance_register', 'payment_recovery');
  end if;

  if tg_op = 'UPDATE' then
    if old.company_id is not distinct from new.company_id
      and old.workforce_id is not distinct from new.workforce_id
      and old.station_id is not distinct from new.station_id
      and old.deduction_head_id is not distinct from new.deduction_head_id
      and old.effective_from is not distinct from new.effective_from
      and old.effective_to is not distinct from new.effective_to
      and old.amount is not distinct from new.amount
      and old.source_type is not distinct from new.source_type
    then
      return new;
    end if;
    v_identity_changed := old.company_id is distinct from new.company_id
      or old.workforce_id is distinct from new.workforce_id
      or old.station_id is distinct from new.station_id
      or old.effective_from is distinct from new.effective_from
      or old.effective_to is distinct from new.effective_to;
  end if;

  if v_old_relevant
    and (tg_op = 'DELETE' or not v_new_relevant or v_identity_changed)
  then
    perform public.enqueue_workforce_payout_dependency_refresh(
      old.company_id,
      old.workforce_id,
      old.station_id,
      old.effective_from,
      old.effective_to,
      coalesce(old.updated_by, old.created_by)
    );
  end if;

  if v_new_relevant then
    -- Inserts and relevant updates queue the new identity with the current
    -- updater. A moved value also queued its old identity above; a same-identity
    -- update reaches only this branch, so its refresh is attributed once to the
    -- actor who made the financial change.
    perform public.enqueue_workforce_payout_dependency_refresh(
      new.company_id,
      new.workforce_id,
      new.station_id,
      new.effective_from,
      new.effective_to,
      coalesce(new.updated_by, new.created_by)
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_deduction_values_90_queue_publication_refresh
  on public.workforce_payout_deduction_values;
create trigger workforce_payout_deduction_values_90_queue_publication_refresh
after insert or update or delete on public.workforce_payout_deduction_values
for each row execute function public.queue_workforce_payout_deduction_refresh();

-- The queue claimant still accepts an optional import batch filter for import
-- requests, but scheduling/coalescing now follows the source-neutral request
-- generation. Patch both canonical and exact-selection claimants with strict
-- structural guards so an unexpected deployed function fails the migration.
do $patch_claimants$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text;
  v_new text;
  v_signatures regprocedure[] := array[
    'public.workforce_claim_payout_publication_refresh_jobs(integer,uuid,uuid)'::regprocedure,
    'public.workforce_claim_selected_payout_publication_refresh_jobs(integer,uuid,uuid[],date,date)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures
  loop
    select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;

    v_old := E'      job.input_batch_id,\n      job.created_at,';
    v_new := E'      job.refresh_request_id,\n      job.created_at,';
    if position(v_old in v_definition) = 0 then
      raise exception 'Unexpected refresh claimant generation select in %.', v_signature::text;
    end if;
    v_definition := replace(v_definition, v_old, v_new);

    v_old := E'    select eligible.input_batch_id\n    from eligible\n    where eligible.identity_order = 1\n    group by eligible.input_batch_id\n    order by min(eligible.created_at), eligible.input_batch_id';
    v_new := E'    select eligible.refresh_request_id\n    from eligible\n    where eligible.identity_order = 1\n    group by eligible.refresh_request_id\n    order by min(eligible.created_at), eligible.refresh_request_id';
    if position(v_old in v_definition) = 0 then
      raise exception 'Unexpected refresh claimant generation boundary in %.', v_signature::text;
    end if;
    v_definition := replace(v_definition, v_old, v_new);

    v_old := 'join target_batch on target_batch.input_batch_id = job.input_batch_id';
    v_new := 'join target_batch on target_batch.refresh_request_id = job.refresh_request_id';
    if position(v_old in v_definition) = 0 then
      raise exception 'Unexpected refresh claimant generation join in %.', v_signature::text;
    end if;
    v_definition := replace(v_definition, v_old, v_new);

    execute v_definition;
  end loop;
end
$patch_claimants$;

-- Generalize the retained revision writer. The outer lease-token wrapper stays
-- unchanged; this implementation now validates either committed-import or
-- payout-dependency provenance and records it on the immutable revision.
do $patch_revision_writer$
declare
  v_signature regprocedure :=
    'public.workforce_apply_payout_publication_input_revisions_without_hardening(uuid,date,date,text,uuid,jsonb)'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;

  v_old := E'  v_revision_batch_id uuid;\n  v_revision_actor_user_id uuid;';
  v_new := E'  v_revision_batch_id uuid;\n  v_revision_request_id uuid;\n  v_revision_source text;\n  v_revision_actor_user_id uuid;';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh revision provenance declaration.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    if not exists (\n      select 1\n      from public.workforce_payout_import_batches batch\n      where batch.id = v_job.input_batch_id\n        and batch.company_id = p_company_id\n        and batch.status = ''committed''\n    ) then\n      raise exception ''The payout publication refresh job does not reference a committed input batch.'';\n    end if;';
  v_new := E'    if v_job.refresh_source = ''input_batch'' then\n      if v_job.input_batch_id is null or not exists (\n        select 1\n        from public.workforce_payout_import_batches batch\n        where batch.id = v_job.input_batch_id\n          and batch.company_id = p_company_id\n          and batch.status = ''committed''\n      ) then\n        raise exception ''The payout publication refresh job does not reference a committed input batch.'';\n      end if;\n    elsif v_job.refresh_source = ''payout_dependency'' then\n      if v_job.input_batch_id is not null then\n        raise exception ''A payout dependency refresh cannot use payout-import provenance.'';\n      end if;\n    else\n      raise exception ''The payout publication refresh source is invalid.'';\n    end if;';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh revision input-batch validation.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    select refresh.input_batch_id, coalesce(refresh.requested_by, p_actor_user_id)\n    into v_revision_batch_id, v_revision_actor_user_id\n    from public.workforce_payout_publication_refresh_jobs refresh\n    where refresh.company_id = p_company_id\n      and refresh.workforce_id = v_workforce_id\n      and refresh.station_id = v_station_id\n      and refresh.period_start = p_period_start\n      and refresh.period_end = p_period_end\n      and refresh.status in (''pending'', ''processing'')\n    order by refresh.created_at desc, refresh.id desc\n    limit 1;';
  v_new := E'    v_revision_batch_id := v_job.input_batch_id;\n    v_revision_request_id := v_job.refresh_request_id;\n    v_revision_source := v_job.refresh_source;\n    v_revision_actor_user_id := coalesce(v_job.requested_by, p_actor_user_id);';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh revision generation lookup.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    where job.company_id = p_company_id\n      and job.workforce_id = v_workforce_id\n      and job.station_id = v_station_id\n      and job.period_start = p_period_start\n      and job.period_end = p_period_end\n      and job.status in (''pending'', ''processing'');';
  v_new := E'    where job.company_id = p_company_id\n      and job.id = v_job_id\n      and job.status = ''processing'';';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh publication completion scope.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    if v_revision_batch_id is null or v_revision_actor_user_id is null then\n      raise exception ''The payout publication refresh generation is no longer open.'';\n    end if;';
  v_new := E'    if v_revision_request_id is null or v_revision_source is null\n      or v_revision_actor_user_id is null\n    then\n      raise exception ''The payout publication refresh generation is no longer open.'';\n    end if;';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh revision generation validation.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'      revision_source,\n      input_batch_id,\n      supersedes_publication_id';
  v_new := E'      revision_source,\n      input_batch_id,\n      refresh_request_id,\n      supersedes_publication_id';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh publication column list.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'      ''worksheet'',\n      ''input_batch_refresh'',\n      v_revision_batch_id,\n      v_previous.id';
  v_new := E'      ''worksheet'',\n      case when v_revision_source = ''input_batch''\n        then ''input_batch_refresh'' else ''dependency_refresh'' end,\n      v_revision_batch_id,\n      v_revision_request_id,\n      v_previous.id';
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected refresh publication provenance values.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end
$patch_revision_writer$;

-- A dependency refresh is another silent replacement of the same payout
-- identity, so retain any mapping-relock lineage exactly as input refreshes do.
create or replace function public.inherit_workforce_payout_mapping_relock_lineage()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.revision_source in ('input_batch_refresh', 'dependency_refresh')
    and new.mapping_relock_id is null
    and new.supersedes_publication_id is not null
  then
    select previous.mapping_relock_id
    into new.mapping_relock_id
    from public.workforce_payout_publications previous
    where previous.id = new.supersedes_publication_id;
  end if;
  return new;
end
$function$;

-- Reconcile dead letters against the source-neutral request anchor of any
-- successful refresh revision, regardless of whether an import or dependency
-- mutation produced it.
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
    or new.revision_source not in ('input_batch_refresh', 'dependency_refresh')
    or new.refresh_request_id is null
  then
    return new;
  end if;

  select job.created_at, job.id
  into v_anchor_created_at, v_anchor_job_id
  from public.workforce_payout_publication_refresh_jobs job
  where job.company_id = new.company_id
    and job.refresh_request_id = new.refresh_request_id
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

-- Repair already-published periods changed before this trigger existed. This
-- is generic across tenants and periods; production currently identifies one
-- such active advance publication (DF1173 / Sep-2026).
do $backfill$
declare
  v_change record;
begin
  for v_change in
    with latest_publication as (
      select distinct on (
        publication.company_id,
        publication.workforce_id,
        publication.station_id,
        publication.period_start,
        publication.period_end
      )
        publication.company_id,
        publication.workforce_id,
        publication.station_id,
        publication.period_start,
        publication.period_end,
        publication.published_at,
        publication.published_by
      from public.workforce_payout_publications publication
      where publication.publication_kind = 'worksheet'
      order by publication.company_id, publication.workforce_id,
        publication.station_id, publication.period_start, publication.period_end,
        publication.revision desc, publication.published_at desc, publication.id desc
    ), changed as (
      select
        latest.company_id,
        latest.workforce_id,
        latest.station_id,
        latest.period_start,
        latest.period_end,
        coalesce(value.updated_by, value.created_by, latest.published_by) requested_by
      from latest_publication latest
      join public.workforce_payout_deduction_values value
        on value.company_id = latest.company_id
       and value.workforce_id = latest.workforce_id
       and value.station_id = latest.station_id
       and value.source_type in ('advance_register', 'payment_recovery')
       and daterange(value.effective_from, value.effective_to, '[]')
         && daterange(latest.period_start, latest.period_end, '[]')
       and greatest(value.created_at, value.updated_at) > latest.published_at
      union
      select
        latest.company_id,
        latest.workforce_id,
        latest.station_id,
        latest.period_start,
        latest.period_end,
        coalesce(recovery.reversed_by, recovery.created_by, latest.published_by) requested_by
      from latest_publication latest
      join public.workforce_advance_recoveries recovery
        on recovery.company_id = latest.company_id
       and recovery.workforce_id = latest.workforce_id
       and recovery.station_id = latest.station_id
       and daterange(recovery.period_start, recovery.period_end, '[]')
         && daterange(latest.period_start, latest.period_end, '[]')
       and (
         recovery.created_at > latest.published_at
         or coalesce(recovery.reversed_at, '-infinity'::timestamptz) > latest.published_at
       )
    )
    select distinct changed.*
    from changed
  loop
    perform public.enqueue_workforce_payout_dependency_refresh(
      v_change.company_id,
      v_change.workforce_id,
      v_change.station_id,
      v_change.period_start,
      v_change.period_end,
      v_change.requested_by
    );
  end loop;
end
$backfill$;

comment on function public.enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) is
  'Queues source-neutral immutable publication revisions for published payout periods affected by a system-managed deduction mutation.';
comment on function public.queue_workforce_payout_deduction_refresh() is
  'Queues publication refresh work only when an ADVANCE or payment-recovery deduction materially changes.';
comment on function public.workforce_apply_payout_publication_input_revisions(uuid,date,date,text,uuid,jsonb) is
  'Lease-token guarded immutable refresh writer for payout imports and audited payout-dependency changes.';

revoke all on function public.prepare_workforce_payout_publication_refresh_job(),
  public.enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid),
  public.queue_workforce_payout_deduction_refresh()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
