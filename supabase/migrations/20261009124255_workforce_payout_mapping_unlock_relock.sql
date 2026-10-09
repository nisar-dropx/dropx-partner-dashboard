begin;

-- A published worksheet remains immutable. This register records the explicit,
-- person-and-month exception that allows an operator to correct provider ID
-- mapping history, and the relock batch records the replacement publication
-- generation that made the correction visible in Dashboard and DropX One.
create table public.workforce_payout_mapping_unlocks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  workforce_id uuid not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'open'
    check (status in ('open', 'relocked')),
  unlock_operation_id uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  reason text not null check (length(btrim(reason)) between 10 and 500),
  base_revision integer not null check (base_revision > 0),
  base_publication_ids uuid[] not null,
  base_station_ids uuid[] not null,
  base_mapping_keys jsonb not null default '[]'::jsonb,
  base_mapping_snapshot jsonb not null default '[]'::jsonb,
  unlocked_by uuid not null references auth.users(id) on delete restrict,
  unlocked_at timestamptz not null default clock_timestamp(),
  relock_id uuid,
  relocked_by uuid references auth.users(id) on delete restrict,
  relocked_at timestamptz,
  constraint workforce_payout_mapping_unlocks_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint workforce_payout_mapping_unlocks_period_check
    check (
      period_start = date_trunc('month', period_start)::date
      and period_end = (period_start + interval '1 month - 1 day')::date
    ),
  constraint workforce_payout_mapping_unlocks_base_shape_check
    check (
      cardinality(base_publication_ids) > 0
      and cardinality(base_station_ids) > 0
      and jsonb_typeof(base_mapping_keys) = 'array'
      and jsonb_typeof(base_mapping_snapshot) = 'array'
    ),
  constraint workforce_payout_mapping_unlocks_state_shape_check
    check (
      (status = 'open' and relock_id is null and relocked_by is null and relocked_at is null)
      or
      (status = 'relocked' and relock_id is not null and relocked_by is not null and relocked_at is not null)
    ),
  unique (company_id, unlock_operation_id, workforce_id)
);

create unique index workforce_payout_mapping_unlocks_open_uidx
  on public.workforce_payout_mapping_unlocks (
    company_id, workforce_id, period_start, period_end
  )
  where status = 'open';

create index workforce_payout_mapping_unlocks_period_idx
  on public.workforce_payout_mapping_unlocks (
    company_id, period_start, period_end, status, unlocked_at desc, id
  );

-- Cover every foreign-key lookup independently of the partial open-row index.
-- This keeps Workforce/user deletion checks and audit joins index-backed even
-- after an unlock has been relocked.
create index workforce_payout_mapping_unlocks_workforce_idx
  on public.workforce_payout_mapping_unlocks (company_id, workforce_id);
create index workforce_payout_mapping_unlocks_unlocked_by_idx
  on public.workforce_payout_mapping_unlocks (unlocked_by);
create index workforce_payout_mapping_unlocks_relocked_by_idx
  on public.workforce_payout_mapping_unlocks (relocked_by)
  where relocked_by is not null;

create table public.workforce_payout_mapping_relocks (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  unlock_ids uuid[] not null,
  source_workforce_ids uuid[] not null,
  affected_workforce_ids uuid[] not null,
  active_locations jsonb not null,
  dependency_hash text not null check (nullif(btrim(dependency_hash), '') is not null),
  change_summary text not null check (length(btrim(change_summary)) between 10 and 500),
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  current_mapping_snapshot jsonb not null default '[]'::jsonb,
  publication_ids uuid[] not null,
  relocked_by uuid not null references auth.users(id) on delete restrict,
  relocked_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_mapping_relocks_period_check
    check (
      period_start = date_trunc('month', period_start)::date
      and period_end = (period_start + interval '1 month - 1 day')::date
    ),
  constraint workforce_payout_mapping_relocks_shape_check
    check (
      cardinality(unlock_ids) > 0
      and cardinality(source_workforce_ids) > 0
      and cardinality(affected_workforce_ids) > 0
      and jsonb_typeof(active_locations) = 'object'
      and jsonb_typeof(current_mapping_snapshot) = 'array'
    )
);

create index workforce_payout_mapping_relocks_period_idx
  on public.workforce_payout_mapping_relocks (
    company_id, period_start, period_end, relocked_at desc, id
  );

create index workforce_payout_mapping_relocks_relocked_by_idx
  on public.workforce_payout_mapping_relocks (relocked_by);

create index workforce_payout_mapping_relocks_affected_idx
  on public.workforce_payout_mapping_relocks
  using gin (affected_workforce_ids);

alter table public.workforce_payout_mapping_unlocks
  add constraint workforce_payout_mapping_unlocks_relock_fk
  foreign key (relock_id)
  references public.workforce_payout_mapping_relocks(id)
  on delete restrict;

create index workforce_payout_mapping_unlocks_relock_idx
  on public.workforce_payout_mapping_unlocks (relock_id)
  where relock_id is not null;

alter table public.workforce_payout_publications
  add column mapping_relock_id uuid;

alter table public.workforce_payout_publications
  add constraint workforce_payout_publications_mapping_relock_fk
  foreign key (mapping_relock_id)
  references public.workforce_payout_mapping_relocks(id)
  on delete restrict
  deferrable initially deferred;

alter table public.workforce_payout_publications
  drop constraint workforce_payout_publications_revision_source_check,
  drop constraint workforce_payout_publications_revision_source_shape_check;

alter table public.workforce_payout_publications
  add constraint workforce_payout_publications_revision_source_check
    check (revision_source in ('initial', 'input_batch_refresh', 'mapping_relock')) not valid,
  add constraint workforce_payout_publications_revision_source_shape_check
    check (
      (
        revision_source = 'initial'
        and input_batch_id is null
        and supersedes_publication_id is null
        and mapping_relock_id is null
      )
      or (
        revision_source = 'input_batch_refresh'
        and input_batch_id is not null
        and supersedes_publication_id is not null
      )
      or (
        revision_source = 'mapping_relock'
        and input_batch_id is null
        and mapping_relock_id is not null
      )
    ) not valid;

alter table public.workforce_payout_publications
  validate constraint workforce_payout_publications_revision_source_check;
alter table public.workforce_payout_publications
  validate constraint workforce_payout_publications_revision_source_shape_check;

create index workforce_payout_publications_mapping_relock_idx
  on public.workforce_payout_publications(mapping_relock_id)
  where mapping_relock_id is not null;

comment on table public.workforce_payout_mapping_unlocks is
  'Immutable audit of each explicit Workforce person/month mapping unlock and the relock batch that closed it.';
comment on table public.workforce_payout_mapping_relocks is
  'Atomic mapping-correction generation: affected identities, active station set, current mapping audit and immutable replacement publications.';
comment on column public.workforce_payout_publications.mapping_relock_id is
  'Mapping relock batch that produced this revision, retained through later input refresh revisions.';

alter table public.workforce_payout_mapping_unlocks enable row level security;
alter table public.workforce_payout_mapping_unlocks force row level security;
alter table public.workforce_payout_mapping_relocks enable row level security;
alter table public.workforce_payout_mapping_relocks force row level security;

revoke all on table public.workforce_payout_mapping_unlocks,
  public.workforce_payout_mapping_relocks
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_mapping_unlocks,
  public.workforce_payout_mapping_relocks
  to service_role;

create policy workforce_payout_mapping_unlocks_service_select
  on public.workforce_payout_mapping_unlocks
  for select to service_role
  using (true);
create policy workforce_payout_mapping_relocks_service_select
  on public.workforce_payout_mapping_relocks
  for select to service_role
  using (true);

create or replace function public.guard_workforce_payout_mapping_unlock_audit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'Workforce payout mapping lock history is immutable.';
  end if;
  if old.status <> 'open'
    or new.status <> 'relocked'
    or (to_jsonb(new) - array['status','relock_id','relocked_by','relocked_at']::text[])
      is distinct from
      (to_jsonb(old) - array['status','relock_id','relocked_by','relocked_at']::text[])
  then
    raise exception 'A mapping unlock can only transition once from open to relocked.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_mapping_unlocks_00_audit_guard
before update or delete on public.workforce_payout_mapping_unlocks
for each row execute function public.guard_workforce_payout_mapping_unlock_audit();

create or replace function public.guard_workforce_payout_mapping_relock_audit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Workforce payout mapping relock history is immutable.';
end
$function$;

create trigger workforce_payout_mapping_relocks_00_audit_guard
before update or delete on public.workforce_payout_mapping_relocks
for each row execute function public.guard_workforce_payout_mapping_relock_audit();

-- An open correction must keep the last stable worksheet frozen. Initial
-- publishing and input-refresh workers cannot race a mapping correction; the
-- relock transaction is the only writer allowed to create the replacement
-- publication generation.
create or replace function public.guard_workforce_payout_publication_during_mapping_unlock()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.publication_kind = 'worksheet'
    and new.revision_source <> 'mapping_relock'
    and exists (
      select 1
      from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = new.company_id
        and unlock.period_start = new.period_start
        and unlock.period_end = new.period_end
        and unlock.status = 'open'
        and (
          unlock.workforce_id = new.workforce_id
          or exists (
            select 1
            from jsonb_array_elements(unlock.base_mapping_keys) key
            join public.field_executive_provider_mappings mapping
              on mapping.company_id = unlock.company_id
             and mapping.provider_id = nullif(key ->> 'provider_id', '')::uuid
             and upper(btrim(mapping.provider_member_id)) = upper(btrim(key ->> 'provider_member_id'))
            where lower(coalesce(mapping.status, '')) <> 'cancelled'
              and daterange(
                mapping.effective_from,
                coalesce(mapping.effective_to, 'infinity'::date),
                '[]'
              ) && daterange(unlock.period_start, unlock.period_end, '[]')
              and public.workforce_provider_mapping_person(
                mapping.company_id,
                mapping.workforce_id,
                mapping.field_executive_id,
                mapping.employee_id,
                mapping.contractor_id
              ) = new.workforce_id
          )
        )
    )
  then
    raise exception 'Provider mapping is unlocked for this Workforce payout month. Relock and republish it before creating another payout revision.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_publications_04_mapping_unlock_guard
before insert on public.workforce_payout_publications
for each row execute function public.guard_workforce_payout_publication_during_mapping_unlock();

-- Input refreshes after a mapping correction remain part of the same active
-- identity/location generation in DropX One.
create or replace function public.inherit_workforce_payout_mapping_relock_lineage()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.revision_source = 'input_batch_refresh'
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

create trigger workforce_payout_publications_05_mapping_relock_lineage
before insert on public.workforce_payout_publications
for each row execute function public.inherit_workforce_payout_mapping_relock_lineage();

create or replace function public.workforce_payout_mapping_unlock_impacted_ids(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_unlock_ids uuid[]
)
returns uuid[]
language sql
security definer
set search_path = ''
stable
as $function$
  with selected_unlocks as (
    select unlock.id, unlock.workforce_id, unlock.base_mapping_keys
    from public.workforce_payout_mapping_unlocks unlock
    where unlock.company_id = p_company_id
      and unlock.period_start = p_period_start
      and unlock.period_end = p_period_end
      and unlock.status = 'open'
      and unlock.id = any(coalesce(p_unlock_ids, '{}'::uuid[]))
  ),
  mapping_keys as (
    select distinct
      nullif(key ->> 'provider_id', '')::uuid as provider_id,
      upper(btrim(key ->> 'provider_member_id')) as provider_member_id
    from selected_unlocks unlock
    cross join lateral jsonb_array_elements(unlock.base_mapping_keys) key
    where nullif(key ->> 'provider_id', '') is not null
      and nullif(upper(btrim(key ->> 'provider_member_id')), '') is not null
  ),
  current_people as (
    select distinct public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) as workforce_id
    from public.field_executive_provider_mappings mapping
    join mapping_keys key
      on key.provider_id = mapping.provider_id
     and key.provider_member_id = upper(btrim(mapping.provider_member_id))
    where mapping.company_id = p_company_id
      and lower(coalesce(mapping.status, '')) <> 'cancelled'
      and daterange(mapping.effective_from, coalesce(mapping.effective_to, 'infinity'::date), '[]')
        && daterange(p_period_start, p_period_end, '[]')
  ),
  impacted as (
    select workforce_id from selected_unlocks
    union
    select workforce_id from current_people where workforce_id is not null
  )
  select coalesce(array_agg(workforce_id order by workforce_id), '{}'::uuid[])
  from impacted;
$function$;

revoke all on function public.workforce_payout_mapping_unlock_impacted_ids(
  uuid, date, date, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_payout_mapping_unlock_impacted_ids(
  uuid, date, date, uuid[]
) to service_role;

create or replace function public.workforce_payout_mapping_revision_state(
  p_company_id uuid,
  p_workforce_id uuid
)
returns table (
  period_start date,
  period_end date,
  revision_pending boolean,
  mapping_relock_id uuid,
  active_station_ids uuid[]
)
language sql
security definer
set search_path = ''
stable
as $function$
  with open_periods as (
    select distinct unlock.period_start, unlock.period_end
    from public.workforce_payout_mapping_unlocks unlock
    where unlock.company_id = p_company_id
      and unlock.status = 'open'
      and (
        unlock.workforce_id = p_workforce_id
        or exists (
          select 1
          from jsonb_array_elements(unlock.base_mapping_keys) key
          join public.field_executive_provider_mappings mapping
            on mapping.company_id = unlock.company_id
           and mapping.provider_id = nullif(key ->> 'provider_id', '')::uuid
           and upper(btrim(mapping.provider_member_id)) = upper(btrim(key ->> 'provider_member_id'))
          where lower(coalesce(mapping.status, '')) <> 'cancelled'
            and daterange(
              mapping.effective_from,
              coalesce(mapping.effective_to, 'infinity'::date),
              '[]'
            ) && daterange(unlock.period_start, unlock.period_end, '[]')
            and public.workforce_provider_mapping_person(
              mapping.company_id,
              mapping.workforce_id,
              mapping.field_executive_id,
              mapping.employee_id,
              mapping.contractor_id
            ) = p_workforce_id
        )
      )
  ),
  latest_relocks as (
    select distinct on (relock.period_start, relock.period_end)
      relock.id,
      relock.period_start,
      relock.period_end,
      relock.active_locations
    from public.workforce_payout_mapping_relocks relock
    where relock.company_id = p_company_id
      and relock.affected_workforce_ids @> array[p_workforce_id]::uuid[]
    order by
      relock.period_start,
      relock.period_end,
      relock.relocked_at desc,
      relock.id desc
  ),
  periods as (
    select open_periods.period_start, open_periods.period_end from open_periods
    union
    select latest_relocks.period_start, latest_relocks.period_end from latest_relocks
  )
  select
    periods.period_start,
    periods.period_end,
    open_periods.period_start is not null as revision_pending,
    latest_relocks.id as mapping_relock_id,
    case
      when latest_relocks.id is null then null::uuid[]
      when jsonb_typeof(latest_relocks.active_locations -> (p_workforce_id::text)) = 'array' then
        coalesce(
          array(
            select station_id::uuid
            from jsonb_array_elements_text(
              latest_relocks.active_locations -> (p_workforce_id::text)
            ) station_id
            order by station_id
          ),
          '{}'::uuid[]
        )
      else '{}'::uuid[]
    end as active_station_ids
  from periods
  left join open_periods
    on open_periods.period_start = periods.period_start
   and open_periods.period_end = periods.period_end
  left join latest_relocks
    on latest_relocks.period_start = periods.period_start
   and latest_relocks.period_end = periods.period_end
  order by periods.period_start desc, periods.period_end desc;
$function$;

comment on function public.workforce_payout_mapping_revision_state(uuid, uuid) is
  'Returns exact open mapping-revision periods and the latest active station manifest for one Workforce identity, including identities that currently own an unlocked provider mapping.';

revoke all on function public.workforce_payout_mapping_revision_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.workforce_payout_mapping_revision_state(uuid, uuid)
  to service_role;

-- Finalized payroll membership is itself financial state. Freeze every item in
-- an approved/paid run so a direct table write cannot add, remove, exclude or
-- reassign a person after the run-status gate has completed. The only expected
-- post-approval item mutation is the canonical ready -> paid transition.
--
-- This trigger deliberately locks Workforce identities before company mutexes,
-- then re-reads run status without taking a run-row lock. Payroll status updates
-- already own the run row before their trigger fires; locking it here would
-- invert the shared Workforce -> company order and could deadlock.
create or replace function public.guard_finalized_workforce_payroll_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_company_id uuid;
  v_old_workforce_id uuid;
  v_old_run_id uuid;
  v_new_company_id uuid;
  v_new_workforce_id uuid;
  v_new_run_id uuid;
  v_company_id uuid;
  v_expected_workforce_count integer;
  v_locked_workforce_count integer;
  v_old_run_status text;
  v_new_run_status text;
  v_old_final boolean := false;
  v_new_final boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_company_id := old.company_id;
    v_old_workforce_id := old.workforce_id;
    v_old_run_id := old.payroll_run_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_company_id := new.company_id;
    v_new_workforce_id := new.workforce_id;
    v_new_run_id := new.payroll_run_id;
  end if;

  select count(*)
  into v_expected_workforce_count
  from (
    select distinct pair.company_id, pair.workforce_id
    from (values
      (v_old_company_id, v_old_workforce_id),
      (v_new_company_id, v_new_workforce_id)
    ) pair(company_id, workforce_id)
    where pair.company_id is not null
      and pair.workforce_id is not null
  ) affected;

  perform 1
  from public.workforce workforce
  join (
    select distinct pair.company_id, pair.workforce_id
    from (values
      (v_old_company_id, v_old_workforce_id),
      (v_new_company_id, v_new_workforce_id)
    ) pair(company_id, workforce_id)
    where pair.company_id is not null
      and pair.workforce_id is not null
  ) affected
    on affected.company_id = workforce.company_id
   and affected.workforce_id = workforce.id
  order by workforce.company_id, workforce.id
  for update of workforce;
  get diagnostics v_locked_workforce_count = row_count;
  if v_locked_workforce_count <> v_expected_workforce_count then
    raise exception 'Invalid payroll associate scope.';
  end if;

  for v_company_id in
    select distinct pair.company_id
    from (values (v_old_company_id), (v_new_company_id)) pair(company_id)
    where pair.company_id is not null
    order by pair.company_id
  loop
    perform public.lock_workforce_payment_allocation_company(v_company_id);
  end loop;

  if v_old_run_id is not null then
    select lower(coalesce(run.status, ''))
    into v_old_run_status
    from public.workforce_payroll_runs run
    where run.company_id = v_old_company_id
      and run.id = v_old_run_id;
    v_old_final := found and v_old_run_status in ('approved', 'paid');
  end if;

  if v_new_run_id is not null then
    select lower(coalesce(run.status, ''))
    into v_new_run_status
    from public.workforce_payroll_runs run
    where run.company_id = v_new_company_id
      and run.id = v_new_run_id;
    if not found then
      raise exception 'Invalid payroll company scope.';
    end if;
    v_new_final := v_new_run_status in ('approved', 'paid');
  end if;

  if tg_op = 'INSERT' then
    if v_new_final then
      raise exception 'Approved or paid Workforce payroll items are immutable.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if v_old_final then
      raise exception 'Approved or paid Workforce payroll items are immutable.';
    end if;
    return old;
  end if;

  if not v_old_final and not v_new_final then
    return new;
  end if;

  if old.company_id = new.company_id
    and old.payroll_run_id = new.payroll_run_id
    and old.workforce_id = new.workforce_id
    and lower(coalesce(old.status, '')) = 'ready'
    and lower(coalesce(new.status, '')) = 'paid'
    and (to_jsonb(new) - array['status', 'updated_at']::text[])
      is not distinct from
      (to_jsonb(old) - array['status', 'updated_at']::text[])
  then
    return new;
  end if;

  raise exception 'Approved or paid Workforce payroll items are immutable; only the ready-to-paid payment transition is allowed.';
end
$function$;

drop trigger if exists workforce_payroll_items_00_finalized_guard
  on public.workforce_payroll_items;
create trigger workforce_payroll_items_00_finalized_guard
before insert or update or delete on public.workforce_payroll_items
for each row execute function public.guard_finalized_workforce_payroll_item();

-- A row trigger cannot protect TRUNCATE, and application code has no legitimate
-- reason to truncate financial payroll history.
revoke truncate on table public.workforce_payroll_items from service_role;

-- Keep financial/review terminal states and background refresh work from
-- overtaking an open mapping correction. Every path takes the same
-- Workforce-row -> company-mutex order used by unlock/relock.
create or replace function public.guard_workforce_payroll_mapping_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status is not distinct from old.status
    or lower(coalesce(new.status, '')) not in ('approved', 'paid')
  then
    return new;
  end if;

  perform 1
  from public.workforce workforce
  join public.workforce_payroll_items item
    on item.company_id = workforce.company_id
   and item.workforce_id = workforce.id
  where item.company_id = new.company_id
    and item.payroll_run_id = new.id
    and coalesce(item.status, '') <> 'excluded'
  order by workforce.id
  for update of workforce;

  perform public.lock_workforce_payment_allocation_company(new.company_id);

  if exists (
    select 1
    from public.workforce_payroll_items item
    cross join lateral public.workforce_payout_mapping_revision_state(
      new.company_id,
      item.workforce_id
    ) revision
    where item.company_id = new.company_id
      and item.payroll_run_id = new.id
      and coalesce(item.status, '') <> 'excluded'
      and daterange(revision.period_start, revision.period_end, '[]')
        && daterange(new.period_start, new.period_end, '[]')
      and revision.revision_pending
  ) then
    raise exception 'Relock every open payout mapping correction before approving or paying this Workforce payroll.';
  end if;

  return new;
end
$function$;

drop trigger if exists workforce_01_mapping_unlock_payroll_gate
  on public.workforce_payroll_runs;
create trigger workforce_01_mapping_unlock_payroll_gate
before update of status on public.workforce_payroll_runs
for each row execute function public.guard_workforce_payroll_mapping_unlock();

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
  then
    perform 1
    from public.workforce workforce
    where workforce.company_id = old.company_id
      and workforce.id = old.subject_id
    for update;
    perform public.lock_workforce_payment_allocation_company(old.company_id);

    if exists (
      select 1
      from public.workforce_payout_mapping_revision_state(
        old.company_id,
        old.subject_id
      ) revision
      where revision.period_start = old.period_start
        and revision.period_end = old.period_end
        and revision.revision_pending
    ) then
      raise exception 'Relock this payout mapping correction before approving or cancelling its review.';
    end if;

    if exists (
      select 1
      from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = old.company_id
        and job.workforce_id = old.subject_id
        and job.station_id = old.location_id
        and job.period_start = old.period_start
        and job.period_end = old.period_end
        and job.status in ('pending', 'processing', 'failed')
    ) then
      raise exception 'This payout has an unresolved publication refresh. Replay failed work or wait for the updated payout before approving or cancelling it.';
    end if;
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

create or replace function public.guard_workforce_payout_refresh_mapping_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform 1
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and workforce.id = new.workforce_id
  for update;
  perform public.lock_workforce_payment_allocation_company(new.company_id);

  if exists (
    select 1
    from public.workforce_payout_mapping_revision_state(
      new.company_id,
      new.workforce_id
    ) revision
    where revision.period_start = new.period_start
      and revision.period_end = new.period_end
      and revision.revision_pending
  ) then
    raise exception 'Relock this payout mapping correction before changing its published payout inputs.';
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_publication_refresh_jobs_00_mapping_unlock
  on public.workforce_payout_publication_refresh_jobs;
create trigger workforce_payout_publication_refresh_jobs_00_mapping_unlock
before insert on public.workforce_payout_publication_refresh_jobs
for each row execute function public.guard_workforce_payout_refresh_mapping_unlock();

create or replace function public.workforce_claim_payout_review_notification(
  p_publication_id uuid,
  p_attempted_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_publication public.workforce_payout_publications%rowtype;
begin
  if p_publication_id is null or p_attempted_at is null then
    return null;
  end if;

  select publication.*
  into v_publication
  from public.workforce_payout_publications publication
  where publication.id = p_publication_id;
  if not found then return null; end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = v_publication.company_id
    and workforce.id = v_publication.workforce_id
  for update;
  perform public.lock_workforce_payment_allocation_company(v_publication.company_id);

  select publication.*
  into v_publication
  from public.workforce_payout_publications publication
  where publication.id = p_publication_id
  for update;
  if not found
    or v_publication.notification_status <> 'pending'
    or v_publication.notify_at > p_attempted_at
  then
    return null;
  end if;

  if exists (
    select 1
    from public.workforce_payout_mapping_revision_state(
      v_publication.company_id,
      v_publication.workforce_id
    ) revision
    where revision.period_start = v_publication.period_start
      and revision.period_end = v_publication.period_end
      and revision.revision_pending
  ) then
    return null;
  end if;

  update public.workforce_payout_publications publication
  set notification_status = 'sending',
      notification_attempted_at = p_attempted_at
  where publication.id = v_publication.id;
  return v_publication.id;
end
$function$;

revoke all on function public.workforce_claim_payout_review_notification(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.workforce_claim_payout_review_notification(uuid, timestamptz)
  to service_role;

create or replace function public.workforce_unlock_payout_mappings(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_period_start date,
  p_period_end date,
  p_workforce_ids uuid[],
  p_operation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workforce_id uuid;
  v_existing public.workforce_payout_mapping_unlocks%rowtype;
  v_unlock_id uuid;
  v_publication_ids uuid[];
  v_station_ids uuid[];
  v_base_revision integer;
  v_mapping_snapshot jsonb;
  v_mapping_keys jsonb;
  v_unlock_ids uuid[] := '{}'::uuid[];
  v_unlocked integer := 0;
  v_request_fingerprint text;
  v_existing_count integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'The mapping unlock actor is unavailable.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Mapping unlock is available only for one complete calendar month.';
  end if;
  if p_workforce_ids is null
    or cardinality(p_workforce_ids) < 1
    or cardinality(p_workforce_ids) > 50
    or cardinality(p_workforce_ids) <> (
      select count(distinct id) from unnest(p_workforce_ids) id
    )
  then
    raise exception 'Select between 1 and 50 unique Workforce IDs.';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception 'Enter an unlock reason between 10 and 500 characters.';
  end if;

  v_request_fingerprint := md5(jsonb_build_object(
    'company_id', p_company_id,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'workforce_ids', (
      select jsonb_agg(id order by id) from unnest(p_workforce_ids) id
    ),
    'reason', btrim(p_reason)
  )::text);

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = any(p_workforce_ids)
  order by workforce.id
  for update;
  if (select count(*) from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.deleted_at is null
        and workforce.migration_state <> 'reclassified'
        and workforce.id = any(p_workforce_ids)) <> cardinality(p_workforce_ids)
  then
    raise exception 'One or more selected Workforce IDs are unavailable.';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- The company mutex makes an operation UUID a strict idempotency boundary,
  -- including concurrent retries. A reused UUID with any different request is
  -- rejected instead of growing a partial second batch.
  select count(*), coalesce(array_agg(unlock.id order by unlock.workforce_id), '{}'::uuid[])
  into v_existing_count, v_unlock_ids
  from public.workforce_payout_mapping_unlocks unlock
  where unlock.company_id = p_company_id
    and unlock.unlock_operation_id = p_operation_id;
  if v_existing_count > 0 then
    if v_existing_count <> cardinality(p_workforce_ids)
      or exists (
        select 1
        from public.workforce_payout_mapping_unlocks unlock
        where unlock.company_id = p_company_id
          and unlock.unlock_operation_id = p_operation_id
          and (
            unlock.request_fingerprint <> v_request_fingerprint
            or not (unlock.workforce_id = any(p_workforce_ids))
          )
      )
      or exists (
        select 1 from unnest(p_workforce_ids) requested(id)
        where not exists (
          select 1
          from public.workforce_payout_mapping_unlocks unlock
          where unlock.company_id = p_company_id
            and unlock.unlock_operation_id = p_operation_id
            and unlock.workforce_id = requested.id
        )
      )
    then
      raise exception 'The mapping unlock operation ID belongs to another request.';
    end if;
    return jsonb_build_object(
      'unlocked', v_existing_count,
      'unlock_ids', to_jsonb(v_unlock_ids),
      'workforce_ids', to_jsonb(p_workforce_ids)
    );
  end if;

  v_unlock_ids := '{}'::uuid[];

  perform 1
  from public.workforce_payout_publications publication
  where publication.company_id = p_company_id
    and publication.publication_kind = 'worksheet'
    and publication.workforce_id = any(p_workforce_ids)
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
  order by publication.workforce_id, publication.station_id,
    publication.revision, publication.id
  for update;

  for v_workforce_id in
    select id from unnest(p_workforce_ids) id order by id
  loop
    if exists (
      select 1 from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = p_company_id
        and unlock.workforce_id = v_workforce_id
        and unlock.period_start = p_period_start
        and unlock.period_end = p_period_end
        and unlock.status = 'open'
    ) then
      raise exception 'A selected Workforce ID is already unlocked for this payout month.';
    end if;
    if exists (
      select 1
      from public.workforce_payout_review_submissions review
      where review.company_id = p_company_id
        and review.subject_type = 'workforce'
        and review.subject_id = v_workforce_id
        and review.period_start = p_period_start
        and review.period_end = p_period_end
        and review.status in ('approved', 'cancelled')
    ) then
      raise exception 'An approved or cancelled payout review cannot be unlocked.';
    end if;
    if exists (
      select 1
      from public.workforce_payroll_items item
      join public.workforce_payroll_runs run
        on run.company_id = item.company_id
       and run.id = item.payroll_run_id
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and coalesce(item.status, '') <> 'excluded'
        and lower(coalesce(run.status, '')) in ('approved', 'paid')
        and daterange(run.period_start, run.period_end, '[]')
          && daterange(p_period_start, p_period_end, '[]')
    ) then
      raise exception 'An approved or paid Workforce payroll period cannot be unlocked.';
    end if;
    if exists (
      select 1 from public.workforce_payout_publications publication
      where publication.company_id = p_company_id
        and publication.publication_kind = 'worksheet'
        and publication.workforce_id = v_workforce_id
        and publication.period_start = p_period_start
        and publication.period_end = p_period_end
        and publication.notification_status = 'sending'
    ) then
      raise exception 'A payout notification is currently sending. Retry after its delivery state is known.';
    end if;
    if exists (
      select 1 from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = p_company_id
        and job.workforce_id = v_workforce_id
        and job.period_start = p_period_start
        and job.period_end = p_period_end
        and job.status in ('pending', 'processing', 'failed')
    ) then
      raise exception 'This payout has an unresolved publication refresh. Complete or replay it before unlocking mappings.';
    end if;

    select
      array_agg(publication.id order by publication.revision, publication.id),
      array_agg(distinct publication.station_id order by publication.station_id),
      max(publication.revision)
    into v_publication_ids, v_station_ids, v_base_revision
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_workforce_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;
    if v_base_revision is null then
      raise exception 'Only a published Workforce payout can have its mapping unlocked.';
    end if;

    select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.effective_from, mapping.id), '[]'::jsonb)
    into v_mapping_snapshot
    from public.field_executive_provider_mappings mapping
    where mapping.company_id = p_company_id
      and lower(coalesce(mapping.status, '')) <> 'cancelled'
      and public.workforce_provider_mapping_person(
        mapping.company_id, mapping.workforce_id, mapping.field_executive_id,
        mapping.employee_id, mapping.contractor_id
      ) = v_workforce_id
      and daterange(mapping.effective_from, coalesce(mapping.effective_to, 'infinity'::date), '[]')
        && daterange(p_period_start, p_period_end, '[]');

    select coalesce(jsonb_agg(key_value order by key_value ->> 'provider_id', key_value ->> 'provider_member_id'), '[]'::jsonb)
    into v_mapping_keys
    from (
      select distinct jsonb_build_object(
        'provider_id', mapping.provider_id,
        'provider_member_id', upper(btrim(mapping.provider_member_id))
      ) as key_value
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = p_company_id
        and lower(coalesce(mapping.status, '')) <> 'cancelled'
        and public.workforce_provider_mapping_person(
          mapping.company_id, mapping.workforce_id, mapping.field_executive_id,
          mapping.employee_id, mapping.contractor_id
        ) = v_workforce_id
        and daterange(mapping.effective_from, coalesce(mapping.effective_to, 'infinity'::date), '[]')
          && daterange(p_period_start, p_period_end, '[]')
    ) keys;
    if jsonb_array_length(v_mapping_keys) = 0 then
      raise exception 'The published payout has no provider mapping to unlock.';
    end if;

    insert into public.workforce_payout_mapping_unlocks (
      company_id, workforce_id, period_start, period_end,
      unlock_operation_id, request_fingerprint, reason, base_revision,
      base_publication_ids, base_station_ids,
      base_mapping_keys, base_mapping_snapshot,
      unlocked_by
    ) values (
      p_company_id, v_workforce_id, p_period_start, p_period_end,
      p_operation_id, v_request_fingerprint, btrim(p_reason), v_base_revision,
      v_publication_ids, v_station_ids,
      v_mapping_keys, v_mapping_snapshot,
      p_actor_user_id
    ) returning id into v_unlock_id;

    update public.workforce_payout_publications publication
    set notification_status = 'superseded',
        notification_error = case
          when publication.notification_status = 'uncertain'
            then coalesce(publication.notification_error, 'Superseded by an operator mapping correction.')
          else publication.notification_error
        end
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_workforce_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
      and publication.notification_status in ('pending', 'failed', 'uncertain');

    v_unlock_ids := array_append(v_unlock_ids, v_unlock_id);
    v_unlocked := v_unlocked + 1;
  end loop;

  return jsonb_build_object(
    'unlocked', v_unlocked,
    'unlock_ids', to_jsonb(v_unlock_ids),
    'workforce_ids', to_jsonb(p_workforce_ids)
  );
end
$function$;

revoke all on function public.workforce_unlock_payout_mappings(
  uuid, uuid, date, date, uuid[], uuid, text
) from public, anon, authenticated;
grant execute on function public.workforce_unlock_payout_mappings(
  uuid, uuid, date, date, uuid[], uuid, text
) to service_role;

create or replace function public.workforce_relock_payout_mappings(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_period_start date,
  p_period_end date,
  p_unlock_ids uuid[],
  p_operation_id uuid,
  p_change_summary text,
  p_expected_dependency_hash text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_mapping_relocks%rowtype;
  v_impacted_ids uuid[];
  v_rechecked_ids uuid[];
  v_source_ids uuid[];
  v_current_hash text;
  v_workforce_id uuid;
  v_item jsonb;
  v_station_id uuid;
  v_snapshot jsonb;
  v_snapshot_hash text;
  v_review_id uuid;
  v_previous public.workforce_payout_publications%rowtype;
  v_baseline public.workforce_payout_publications%rowtype;
  v_next_revision integer;
  v_publication_id uuid;
  v_publication_ids uuid[] := '{}'::uuid[];
  v_active_station_ids uuid[];
  v_active_locations jsonb := '{}'::jsonb;
  v_current_mapping_snapshot jsonb;
  v_changed integer;
  v_request_fingerprint text;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'The mapping relock actor is unavailable.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Mapping relock is available only for one complete calendar month.';
  end if;
  if p_unlock_ids is null
    or cardinality(p_unlock_ids) < 1
    or cardinality(p_unlock_ids) > 50
    or cardinality(p_unlock_ids) <> (
      select count(distinct id) from unnest(p_unlock_ids) id
    )
  then
    raise exception 'Select between 1 and 50 unique mapping unlocks.';
  end if;
  if length(btrim(coalesce(p_change_summary, ''))) not between 10 and 500 then
    raise exception 'Enter a relock change summary between 10 and 500 characters.';
  end if;
  if nullif(btrim(coalesce(p_expected_dependency_hash, '')), '') is null then
    raise exception 'The payout worksheet version is required.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The recalculated payout snapshots are required.';
  end if;

  v_request_fingerprint := md5(jsonb_build_object(
    'company_id', p_company_id,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'unlock_ids', (
      select jsonb_agg(id order by id) from unnest(p_unlock_ids) id
    ),
    'change_summary', btrim(p_change_summary),
    'dependency_hash', p_expected_dependency_hash,
    'items', (
      select jsonb_agg(value order by value ->> 'workforce_id', value ->> 'station_id')
      from jsonb_array_elements(p_items)
    )
  )::text);

  select relock.* into v_existing
  from public.workforce_payout_mapping_relocks relock
  where relock.id = p_operation_id;
  if found then
    if v_existing.company_id <> p_company_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.request_fingerprint <> v_request_fingerprint
    then
      raise exception 'The relock operation ID belongs to another request.';
    end if;
    return jsonb_build_object(
      'relocked', cardinality(v_existing.source_workforce_ids),
      'affected', cardinality(v_existing.affected_workforce_ids),
      'published', cardinality(v_existing.publication_ids),
      'publication_ids', to_jsonb(v_existing.publication_ids),
      'relock_id', v_existing.id
    );
  end if;

  if (select count(*) from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = p_company_id
        and unlock.period_start = p_period_start
        and unlock.period_end = p_period_end
        and unlock.status = 'open'
        and unlock.id = any(p_unlock_ids)) <> cardinality(p_unlock_ids)
  then
    raise exception 'One or more mapping unlocks changed. Refresh the payout worksheet and try again.';
  end if;

  v_impacted_ids := public.workforce_payout_mapping_unlock_impacted_ids(
    p_company_id, p_period_start, p_period_end, p_unlock_ids
  );
  if cardinality(v_impacted_ids) < 1 then
    raise exception 'No Workforce IDs are available for this mapping relock.';
  end if;

  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = any(v_impacted_ids)
  order by workforce.id
  for update;
  if (select count(*) from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.deleted_at is null
        and workforce.migration_state <> 'reclassified'
        and workforce.id = any(v_impacted_ids)) <> cardinality(v_impacted_ids)
  then
    raise exception 'An affected Workforce identity is unavailable.';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  select relock.* into v_existing
  from public.workforce_payout_mapping_relocks relock
  where relock.id = p_operation_id;
  if found then
    if v_existing.company_id <> p_company_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.request_fingerprint <> v_request_fingerprint
    then
      raise exception 'The relock operation ID belongs to another request.';
    end if;
    return jsonb_build_object(
      'relocked', cardinality(v_existing.source_workforce_ids),
      'affected', cardinality(v_existing.affected_workforce_ids),
      'published', cardinality(v_existing.publication_ids),
      'publication_ids', to_jsonb(v_existing.publication_ids),
      'relock_id', v_existing.id
    );
  end if;

  perform 1
  from public.workforce_payout_publications publication
  where publication.company_id = p_company_id
    and publication.publication_kind = 'worksheet'
    and publication.workforce_id = any(v_impacted_ids)
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
  order by publication.workforce_id, publication.station_id,
    publication.revision, publication.id
  for update;

  perform 1
  from public.workforce_payout_mapping_unlocks unlock
  where unlock.company_id = p_company_id
    and unlock.id = any(p_unlock_ids)
  order by unlock.workforce_id, unlock.id
  for update;
  if (select count(*) from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = p_company_id
        and unlock.period_start = p_period_start
        and unlock.period_end = p_period_end
        and unlock.status = 'open'
        and unlock.id = any(p_unlock_ids)) <> cardinality(p_unlock_ids)
  then
    raise exception 'One or more mapping unlocks changed. Refresh the payout worksheet and try again.';
  end if;

  v_rechecked_ids := public.workforce_payout_mapping_unlock_impacted_ids(
    p_company_id, p_period_start, p_period_end, p_unlock_ids
  );
  if v_rechecked_ids is distinct from v_impacted_ids then
    raise exception 'Provider mappings changed while relock was starting. Refresh and try again.';
  end if;

  select array_agg(unlock.workforce_id order by unlock.workforce_id)
  into v_source_ids
  from public.workforce_payout_mapping_unlocks unlock
  where unlock.company_id = p_company_id
    and unlock.id = any(p_unlock_ids);

  if exists (
    select 1
    from public.workforce_payout_review_submissions review
    where review.company_id = p_company_id
      and review.subject_type = 'workforce'
      and review.subject_id = any(v_impacted_ids)
      and review.period_start = p_period_start
      and review.period_end = p_period_end
      and review.status in ('approved', 'cancelled')
  ) then
    raise exception 'Approved or cancelled payout reviews cannot be replaced by a mapping relock.';
  end if;
  if exists (
    select 1
    from public.workforce_payroll_items item
    join public.workforce_payroll_runs run
      on run.company_id = item.company_id
     and run.id = item.payroll_run_id
    where item.company_id = p_company_id
      and item.workforce_id = any(v_impacted_ids)
      and coalesce(item.status, '') <> 'excluded'
      and daterange(run.period_start, run.period_end, '[]')
        && daterange(p_period_start, p_period_end, '[]')
      and lower(coalesce(run.status, '')) in ('approved', 'paid')
  ) then
    raise exception 'Approved or paid Workforce payroll cannot be replaced by a mapping relock.';
  end if;
  if exists (
    select 1 from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = any(v_impacted_ids)
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
      and publication.notification_status = 'sending'
  ) then
    raise exception 'A payout notification is currently sending. Retry after its delivery state is known.';
  end if;
  if exists (
    select 1 from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.workforce_id = any(v_impacted_ids)
      and job.period_start = p_period_start
      and job.period_end = p_period_end
      and job.status in ('pending', 'processing', 'failed')
  ) then
    raise exception 'An affected payout has an unresolved publication refresh. Complete or replay it before relocking mappings.';
  end if;

  v_current_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id, p_period_start, p_period_end
  );
  if v_current_hash is distinct from p_expected_dependency_hash then
    raise exception 'Payout inputs changed while relock was being prepared. Refresh and review the recalculated amounts.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where nullif(item ->> 'workforce_id', '') is null
      or nullif(item ->> 'station_id', '') is null
      or nullif(item ->> 'snapshot_hash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(item -> 'snapshot') <> 'object'
      or not (nullif(item ->> 'workforce_id', '')::uuid = any(v_impacted_ids))
      or item #>> '{snapshot,schema_version}' <> '2'
      or item #>> '{snapshot,source}' <> 'workforce_payout_worksheet'
      or item #>> '{snapshot,dependency_hash}' <> p_expected_dependency_hash
      or item #>> '{snapshot,run,period_start}' <> p_period_start::text
      or item #>> '{snapshot,run,period_end}' <> p_period_end::text
      or item #>> '{snapshot,item,workforce_id}' <> item ->> 'workforce_id'
      or item #>> '{snapshot,item,station_id}' <> item ->> 'station_id'
  ) then
    raise exception 'A recalculated payout snapshot is invalid or outside the relock scope.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    group by lower(item ->> 'workforce_id'), lower(item ->> 'station_id')
    having count(*) > 1
  ) then
    raise exception 'The recalculated worksheet contains duplicate Workforce/location rows.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    left join public.stations station
      on station.company_id = p_company_id
     and station.id = nullif(item ->> 'station_id', '')::uuid
    where station.id is null
  ) then
    raise exception 'A recalculated payout location is unavailable.';
  end if;

  -- Every affected person who still owns an active mapping in this month must
  -- have a recalculated worksheet row, including a same-person change to a new
  -- provider-member ID. Original owners may legitimately have no row after a
  -- complete transfer/removal; DropX One hides those old identities from the
  -- relock's active-location manifest.
  if exists (
    with current_people as (
      select distinct public.workforce_provider_mapping_person(
        mapping.company_id,
        mapping.workforce_id,
        mapping.field_executive_id,
        mapping.employee_id,
        mapping.contractor_id
      ) as workforce_id
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = p_company_id
        and lower(coalesce(mapping.status, '')) <> 'cancelled'
        and daterange(
          mapping.effective_from,
          coalesce(mapping.effective_to, 'infinity'::date),
          '[]'
        ) && daterange(p_period_start, p_period_end, '[]')
        and public.workforce_provider_mapping_person(
          mapping.company_id,
          mapping.workforce_id,
          mapping.field_executive_id,
          mapping.employee_id,
          mapping.contractor_id
        ) = any(v_impacted_ids)
    )
    select 1
    from current_people person
    where person.workforce_id is not null
      and not exists (
        select 1
        from jsonb_array_elements(p_items) item
        where nullif(item ->> 'workforce_id', '')::uuid = person.workforce_id
      )
  ) then
    raise exception 'A remapped Workforce payout is missing from the recalculated worksheet. Complete its payment setup, refresh and relock again.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.effective_from, mapping.id), '[]'::jsonb)
  into v_current_mapping_snapshot
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company_id
    and lower(coalesce(mapping.status, '')) <> 'cancelled'
    and public.workforce_provider_mapping_person(
      mapping.company_id, mapping.workforce_id, mapping.field_executive_id,
      mapping.employee_id, mapping.contractor_id
    ) = any(v_impacted_ids)
    and daterange(mapping.effective_from, coalesce(mapping.effective_to, 'infinity'::date), '[]')
      && daterange(p_period_start, p_period_end, '[]');

  for v_workforce_id in select id from unnest(v_impacted_ids) id order by id
  loop
    select coalesce(array_agg((item ->> 'station_id')::uuid order by item ->> 'station_id'), '{}'::uuid[])
    into v_active_station_ids
    from jsonb_array_elements(p_items) item
    where (item ->> 'workforce_id')::uuid = v_workforce_id;

    v_active_locations := v_active_locations
      || jsonb_build_object(v_workforce_id::text, to_jsonb(v_active_station_ids));

    update public.workforce_payout_review_submissions review
    set status = 'returned',
        updated_at = clock_timestamp()
    where review.company_id = p_company_id
      and review.subject_type = 'workforce'
      and review.subject_id = v_workforce_id
      and review.period_start = p_period_start
      and review.period_end = p_period_end
      and review.status = 'under_review'
      and not (review.location_id = any(v_active_station_ids));
  end loop;

  update public.workforce_payout_publications publication
  set notification_status = 'superseded',
      notification_error = case
        when publication.notification_status = 'uncertain'
          then coalesce(publication.notification_error, 'Superseded by a completed operator mapping correction.')
        else publication.notification_error
      end
  where publication.company_id = p_company_id
    and publication.publication_kind = 'worksheet'
    and publication.workforce_id = any(v_impacted_ids)
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
    and publication.notification_status in ('pending', 'failed', 'uncertain');

  for v_item in
    select value from jsonb_array_elements(p_items)
    order by value ->> 'workforce_id', value ->> 'station_id'
  loop
    v_workforce_id := (v_item ->> 'workforce_id')::uuid;
    v_station_id := (v_item ->> 'station_id')::uuid;
    v_snapshot := v_item -> 'snapshot';
    v_snapshot_hash := v_item ->> 'snapshot_hash';
    v_previous := null;
    v_baseline := null;
    v_review_id := null;

    select publication.* into v_previous
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_workforce_id
      and publication.station_id = v_station_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1
    for update;

    if not found then
      select publication.* into v_baseline
      from public.workforce_payout_publications publication
      where publication.company_id = p_company_id
        and publication.publication_kind = 'worksheet'
        and publication.workforce_id = any(v_source_ids)
        and publication.period_start = p_period_start
        and publication.period_end = p_period_end
      order by publication.revision desc, publication.published_at desc, publication.id desc
      limit 1
      for update;
      if not found then
        raise exception 'The source publication for a remapped payout is unavailable.';
      end if;
    else
      v_baseline := v_previous;
    end if;

    insert into public.workforce_payout_review_submissions (
      company_id, subject_type, subject_id, location_id,
      period_start, period_end, status, calculation_snapshot,
      submitted_by, submitted_at, updated_at
    ) values (
      p_company_id, 'workforce', v_workforce_id, v_station_id,
      p_period_start, p_period_end, 'under_review', v_snapshot,
      p_actor_user_id, clock_timestamp(), clock_timestamp()
    )
    on conflict (company_id, subject_type, subject_id, location_id, period_start, period_end)
    do update set
      status = 'under_review',
      calculation_snapshot = excluded.calculation_snapshot,
      updated_at = excluded.updated_at
    where workforce_payout_review_submissions.status in ('under_review', 'returned')
    returning id into v_review_id;
    get diagnostics v_changed = row_count;
    if v_changed <> 1 or v_review_id is null then
      raise exception 'A payout review changed while mappings were being relocked.';
    end if;

    select coalesce(max(publication.revision), 0) + 1
    into v_next_revision
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_workforce_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;

    insert into public.workforce_payout_publications (
      company_id, payroll_run_id, workforce_id, station_id, revision,
      snapshot, published_by, published_at, review_until, notify_at,
      source_calculated_at, notification_status, review_submission_id,
      period_start, period_end, snapshot_hash, dependency_hash,
      notification_config_snapshot, publication_kind,
      revision_source, input_batch_id, supersedes_publication_id,
      mapping_relock_id
    ) values (
      p_company_id, null, v_workforce_id, v_station_id, v_next_revision,
      v_snapshot, p_actor_user_id, clock_timestamp(),
      greatest(v_baseline.review_until, clock_timestamp() + interval '7 days'),
      clock_timestamp(), clock_timestamp(), 'disabled', v_review_id,
      p_period_start, p_period_end, v_snapshot_hash, p_expected_dependency_hash,
      jsonb_build_object(
        'schema_version', 1,
        'event_code', 'workforce_payout_review',
        'app_notification_enabled', false,
        'whatsapp_notification_enabled', false,
        'silent_revision', true,
        'mapping_relock', true
      ),
      'worksheet', 'mapping_relock', null,
      case when v_previous.id is null then null else v_previous.id end,
      p_operation_id
    ) returning id into v_publication_id;

    v_publication_ids := array_append(v_publication_ids, v_publication_id);
  end loop;

  insert into public.workforce_payout_mapping_relocks (
    id, company_id, period_start, period_end,
    unlock_ids, source_workforce_ids, affected_workforce_ids,
    active_locations, dependency_hash, change_summary,
    request_fingerprint, current_mapping_snapshot,
    publication_ids, relocked_by
  ) values (
    p_operation_id, p_company_id, p_period_start, p_period_end,
    p_unlock_ids, v_source_ids, v_impacted_ids,
    v_active_locations, p_expected_dependency_hash, btrim(p_change_summary),
    v_request_fingerprint, v_current_mapping_snapshot,
    v_publication_ids, p_actor_user_id
  );

  update public.workforce_payout_mapping_unlocks unlock
  set status = 'relocked',
      relock_id = p_operation_id,
      relocked_by = p_actor_user_id,
      relocked_at = clock_timestamp()
  where unlock.company_id = p_company_id
    and unlock.id = any(p_unlock_ids)
    and unlock.status = 'open';
  get diagnostics v_changed = row_count;
  if v_changed <> cardinality(p_unlock_ids) then
    raise exception 'One or more mapping unlocks changed before relock completed.';
  end if;

  return jsonb_build_object(
    'relocked', cardinality(v_source_ids),
    'affected', cardinality(v_impacted_ids),
    'published', cardinality(v_publication_ids),
    'publication_ids', to_jsonb(v_publication_ids),
    'relock_id', p_operation_id
  );
end
$function$;

revoke all on function public.workforce_relock_payout_mappings(
  uuid, uuid, date, date, uuid[], uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.workforce_relock_payout_mappings(
  uuid, uuid, date, date, uuid[], uuid, text, text, jsonb
) to service_role;

-- The published-period guard stays the universal table boundary. It ignores a
-- publication only while that exact canonical Workforce/month has an explicit
-- open audit row; the approved/paid guard still runs immediately afterwards.
create or replace function public.guard_published_workforce_provider_mapping()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  old_person uuid;
  new_person uuid;
  old_company uuid;
  new_company uuid;
  old_provider_id uuid;
  new_provider_id uuid;
  old_provider_member_id text;
  new_provider_member_id text;
  old_range daterange := 'empty'::daterange;
  new_range daterange := 'empty'::daterange;
  definition_changed boolean := true;
  locked record;
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(old) - 'updated_at') is not distinct from (to_jsonb(new) - 'updated_at')
  then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    old_company := old.company_id;
    old_person := public.workforce_provider_mapping_person(
      old.company_id, old.workforce_id, old.field_executive_id,
      old.employee_id, old.contractor_id
    );
    old_provider_id := old.provider_id;
    old_provider_member_id := upper(btrim(old.provider_member_id));
    if lower(coalesce(old.status, '')) <> 'cancelled' then
      old_range := daterange(old.effective_from, coalesce(old.effective_to, 'infinity'::date), '[]');
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new_company := new.company_id;
    new_person := public.workforce_provider_mapping_person(
      new.company_id, new.workforce_id, new.field_executive_id,
      new.employee_id, new.contractor_id
    );
    new_provider_id := new.provider_id;
    new_provider_member_id := upper(btrim(new.provider_member_id));
    if lower(coalesce(new.status, '')) <> 'cancelled' then
      new_range := daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]');
    end if;
  end if;

  if tg_op = 'UPDATE' then
    definition_changed := (to_jsonb(old) - array['updated_at','effective_from','effective_to','status']::text[])
      is distinct from
      (to_jsonb(new) - array['updated_at','effective_from','effective_to','status']::text[]);
  end if;

  perform 1
  from public.workforce workforce
  where (workforce.company_id = old_company and workforce.id = old_person)
     or (workforce.company_id = new_company and workforce.id = new_person)
  order by workforce.company_id, workforce.id
  for update;

  for locked in
    select distinct company_id
    from (values (old_company), (new_company)) companies(company_id)
    where company_id is not null
    order by company_id
  loop
    perform public.lock_workforce_payment_allocation_company(locked.company_id);
  end loop;

  if exists (
    select 1
    from public.workforce_payout_publications publication
    where publication.publication_kind = 'worksheet'
      and publication.notification_status = 'sending'
      and (
        (
          publication.company_id = old_company
          and publication.workforce_id = old_person
          and (
            (definition_changed and daterange(publication.period_start, publication.period_end, '[]') && old_range)
            or (not definition_changed and (
              daterange(publication.period_start, publication.period_end, '[]') * old_range
            ) is distinct from (
              daterange(publication.period_start, publication.period_end, '[]') * new_range
            ))
          )
        )
        or (
          publication.company_id = new_company
          and publication.workforce_id = new_person
          and definition_changed
          and daterange(publication.period_start, publication.period_end, '[]') && new_range
        )
      )
  ) then
    raise exception 'A payout notification is currently sending for this mapping period. Retry after its delivery state is known.';
  end if;

  select publication.period_start, publication.period_end
  into locked
  from public.workforce_payout_publications publication
  where publication.publication_kind = 'worksheet'
    and not exists (
      select 1
      from public.workforce_payout_mapping_unlocks unlock
      where unlock.company_id = publication.company_id
        and unlock.period_start = publication.period_start
        and unlock.period_end = publication.period_end
        and unlock.status = 'open'
        and (
          unlock.workforce_id = publication.workforce_id
          or (
            publication.workforce_id = old_person
            and exists (
              select 1
              from jsonb_array_elements(unlock.base_mapping_keys) key
              where nullif(key ->> 'provider_id', '')::uuid = old_provider_id
                and upper(btrim(key ->> 'provider_member_id')) = old_provider_member_id
            )
          )
          or (
            publication.workforce_id = new_person
            and exists (
              select 1
              from jsonb_array_elements(unlock.base_mapping_keys) key
              where nullif(key ->> 'provider_id', '')::uuid = new_provider_id
                and upper(btrim(key ->> 'provider_member_id')) = new_provider_member_id
            )
          )
        )
    )
    and (
      (
        publication.company_id = old_company
        and publication.workforce_id = old_person
        and (
          (definition_changed and daterange(publication.period_start, publication.period_end, '[]') && old_range)
          or (not definition_changed and (
            daterange(publication.period_start, publication.period_end, '[]') * old_range
          ) is distinct from (
            daterange(publication.period_start, publication.period_end, '[]') * new_range
          ))
        )
      )
      or (
        publication.company_id = new_company
        and publication.workforce_id = new_person
        and definition_changed
        and daterange(publication.period_start, publication.period_end, '[]') && new_range
      )
    )
  order by publication.period_start, publication.period_end, publication.id
  limit 1;

  if found then
    raise exception
      'Workforce payout % to % was published to DropX One; unlock this ID and month from Workforce Payouts before remapping.',
      locked.period_start, locked.period_end;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

comment on function public.guard_published_workforce_provider_mapping() is
  'Locks provider mapping history for every published Workforce/month except an explicit open audited unlock; approved/paid payroll guards remain independent.';

-- Keep the same revision boundary inside the database, not only in the DropX
-- One route. Locking the canonical Workforce row serializes this check with
-- unlock/relock, closing the check-to-insert race for disputes.
create or replace function public.guard_workforce_payout_dispute_mapping_revision()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_publication public.workforce_payout_publications%rowtype;
  v_active_stations jsonb;
begin
  perform 1
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and workforce.id = new.workforce_id
  for update;

  select publication.*
  into v_publication
  from public.workforce_payout_publications publication
  where publication.id = new.publication_id
    and publication.company_id = new.company_id
    and publication.workforce_id = new.workforce_id;
  if not found or v_publication.publication_kind <> 'worksheet' then
    return new;
  end if;

  if exists (
    select 1
    from public.workforce_payout_mapping_unlocks unlock
    where unlock.company_id = v_publication.company_id
      and unlock.period_start = v_publication.period_start
      and unlock.period_end = v_publication.period_end
      and unlock.status = 'open'
      and (
        unlock.workforce_id = v_publication.workforce_id
        or exists (
          select 1
          from jsonb_array_elements(unlock.base_mapping_keys) key
          join public.field_executive_provider_mappings mapping
            on mapping.company_id = unlock.company_id
           and mapping.provider_id = nullif(key ->> 'provider_id', '')::uuid
           and upper(btrim(mapping.provider_member_id)) = upper(btrim(key ->> 'provider_member_id'))
          where lower(coalesce(mapping.status, '')) <> 'cancelled'
            and daterange(
              mapping.effective_from,
              coalesce(mapping.effective_to, 'infinity'::date),
              '[]'
            ) && daterange(unlock.period_start, unlock.period_end, '[]')
            and public.workforce_provider_mapping_person(
              mapping.company_id,
              mapping.workforce_id,
              mapping.field_executive_id,
              mapping.employee_id,
              mapping.contractor_id
            ) = v_publication.workforce_id
        )
      )
  ) then
    raise exception 'This payout is being revised after an ID mapping correction. Try again after it is relocked.';
  end if;

  select relock.active_locations -> (v_publication.workforce_id::text)
  into v_active_stations
  from public.workforce_payout_mapping_relocks relock
  where relock.company_id = v_publication.company_id
    and relock.period_start = v_publication.period_start
    and relock.period_end = v_publication.period_end
    and relock.affected_workforce_ids @> array[v_publication.workforce_id]::uuid[]
  order by relock.relocked_at desc, relock.id desc
  limit 1;
  if found and (
    coalesce(jsonb_typeof(v_active_stations), 'null') <> 'array'
    or not coalesce(v_active_stations ? (v_publication.station_id::text), false)
  ) then
    raise exception 'This payout was replaced by an ID mapping correction. Open the current payout before raising a dispute.';
  end if;

  return new;
end
$function$;

create trigger workforce_payout_disputes_00_mapping_revision_guard
before insert on public.workforce_payout_disputes
for each row execute function public.guard_workforce_payout_dispute_mapping_revision();

comment on function public.guard_workforce_payout_dispute_mapping_revision() is
  'Atomically rejects DropX One disputes while an exact payout mapping correction is open or when a relock removed the publication identity/location.';

revoke all on function public.guard_workforce_payout_mapping_unlock_audit()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_mapping_relock_audit()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_publication_during_mapping_unlock()
  from public, anon, authenticated;
revoke all on function public.inherit_workforce_payout_mapping_relock_lineage()
  from public, anon, authenticated;
revoke all on function public.guard_published_workforce_provider_mapping()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_dispute_mapping_revision()
  from public, anon, authenticated;
revoke all on function public.guard_finalized_workforce_payroll_item()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payroll_mapping_unlock()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_review_status_transition()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_refresh_mapping_unlock()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
