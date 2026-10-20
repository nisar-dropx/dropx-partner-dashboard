begin;

-- Payout disputes use a three-person, source-correction workflow:
--
--   open -> pending_final_approval -> approved_for_processing -> processing -> resolved
--              |                           |                       |
--              +-> rejected                +-----------------------+-> processing_blocked
--
-- A company default route is required; a station route may override it. Role arrays are ordered
-- fallback candidates and are snapshotted on the dispute at its first review. The application and
-- database both check page permissions and effective location coverage; this migration also enforces
-- state, role priority, station scope, actor separation and optimistic version.

create table if not exists public.workforce_payout_dispute_workflows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid references public.stations(id) on delete cascade,
  initial_approver_role_ids uuid[] not null,
  final_approver_role_ids uuid[] not null,
  processor_role_ids uuid[] not null,
  is_active boolean not null default true,
  version integer not null default 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_dispute_workflows_version_check check (version > 0)
);

create unique index if not exists workforce_payout_dispute_workflows_company_default_uidx
  on public.workforce_payout_dispute_workflows(company_id)
  where station_id is null;
create unique index if not exists workforce_payout_dispute_workflows_station_uidx
  on public.workforce_payout_dispute_workflows(company_id, station_id)
  where station_id is not null;
create index if not exists workforce_payout_dispute_workflows_active_idx
  on public.workforce_payout_dispute_workflows(company_id, station_id)
  where is_active;

create or replace function public.validate_workforce_payout_dispute_workflow()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_all_roles uuid[];
begin
  new.initial_approver_role_ids := coalesce(new.initial_approver_role_ids, '{}'::uuid[]);
  new.final_approver_role_ids := coalesce(new.final_approver_role_ids, '{}'::uuid[]);
  new.processor_role_ids := coalesce(new.processor_role_ids, '{}'::uuid[]);

  if cardinality(new.initial_approver_role_ids) = 0
    or cardinality(new.final_approver_role_ids) = 0
    or cardinality(new.processor_role_ids) = 0
  then
    raise exception 'Initial approval, final approval and processing each require at least one role.';
  end if;
  if array_position(new.initial_approver_role_ids, null) is not null
    or array_position(new.final_approver_role_ids, null) is not null
    or array_position(new.processor_role_ids, null) is not null
  then
    raise exception 'Workflow role lists cannot contain an empty role.';
  end if;

  v_all_roles := new.initial_approver_role_ids || new.final_approver_role_ids || new.processor_role_ids;
  if (select count(*) from unnest(v_all_roles) role_id)
    <> (select count(distinct role_id) from unnest(v_all_roles) role_id)
  then
    raise exception 'Initial approver, final approver and processor roles must be separate.';
  end if;
  if exists (
    select 1
    from unnest(v_all_roles) configured(role_id)
    left join public.user_roles role
      on role.id = configured.role_id
      and role.company_id = new.company_id
      and role.is_active
    where role.id is null
  ) then
    raise exception 'Every workflow role must be an active role in this company.';
  end if;
  if new.station_id is not null and not exists (
    select 1 from public.stations station
    where station.id = new.station_id and station.company_id = new.company_id
  ) then
    raise exception 'The workflow station is outside this company.';
  end if;

  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  else
    new.version := 1;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

drop trigger if exists workforce_payout_dispute_workflows_validate
  on public.workforce_payout_dispute_workflows;
create trigger workforce_payout_dispute_workflows_validate
before insert or update on public.workforce_payout_dispute_workflows
for each row execute function public.validate_workforce_payout_dispute_workflow();

alter table public.workforce_payout_dispute_workflows enable row level security;
alter table public.workforce_payout_dispute_workflows force row level security;
revoke all on table public.workforce_payout_dispute_workflows from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.workforce_payout_dispute_workflows to service_role;

create or replace function public.workforce_payout_dispute_workflow_snapshot(
  p_company uuid,
  p_station uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'config_id', workflow.id,
    'config_version', workflow.version,
    'scope', case when workflow.station_id is null then 'company' else 'station' end,
    'station_id', workflow.station_id,
    'initial_approver_role_ids', to_jsonb(workflow.initial_approver_role_ids),
    'final_approver_role_ids', to_jsonb(workflow.final_approver_role_ids),
    'processor_role_ids', to_jsonb(workflow.processor_role_ids),
    'captured_at', clock_timestamp()
  )
  from public.workforce_payout_dispute_workflows workflow
  where workflow.company_id = p_company
    and workflow.is_active
    and (workflow.station_id = p_station or workflow.station_id is null)
  order by (workflow.station_id is not null) desc
  limit 1
$function$;

revoke all on function public.workforce_payout_dispute_workflow_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.workforce_payout_dispute_workflow_snapshot(uuid, uuid)
  to service_role;

create or replace function public.workforce_payout_dispute_role_can_edit(
  p_company uuid,
  p_role uuid,
  p_page_code text
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
    from public.user_roles role
    where role.id = p_role
      and role.company_id = p_company
      and role.is_active
      and (
        upper(coalesce(role.code, '')) = 'OWNER'
        or exists (
          select 1
          from public.role_page_permissions permission
          join public.app_pages page
            on page.id = permission.page_id
            and page.is_active
            and page.code = p_page_code
            and (page.company_id = p_company or page.company_id is null)
          where permission.company_id = p_company
            and permission.role_id = role.id
            and permission.can_edit
        )
      )
  )
$function$;

revoke all on function public.workforce_payout_dispute_role_can_edit(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.workforce_payout_dispute_role_can_edit(uuid, uuid, text)
  to service_role;

-- Role arrays are ordered, not a pool of interchangeable actors. Pick the first
-- role that currently has both the required page grants and at least one active
-- person whose effective scope covers the dispute station. A later role is a
-- fallback only while every earlier role is unavailable.
create or replace function public.workforce_payout_dispute_first_eligible_role(
  p_company uuid,
  p_station uuid,
  p_role_ids uuid[],
  p_require_payout_edit boolean default false,
  p_excluded_profile_ids uuid[] default '{}'::uuid[]
)
returns uuid
language sql
volatile
set search_path = ''
as $function$
  with ordered_roles as (
    select candidate.role_id, candidate.priority, role.code, role.location_access_mode
    from unnest(coalesce(p_role_ids, '{}'::uuid[])) with ordinality
      candidate(role_id, priority)
    join public.user_roles role
      on role.id = candidate.role_id
      and role.company_id = p_company
      and role.is_active
  ), role_capabilities as (
    select ordered.*,
      public.workforce_payout_dispute_role_can_edit(
        p_company, ordered.role_id, 'workforce_payout_disputes'
      ) and (
        not coalesce(p_require_payout_edit, false)
        or public.workforce_payout_dispute_role_can_edit(
          p_company, ordered.role_id, 'workforce_payouts'
        )
      ) as dashboard_ready,
      public.workforce_payout_dispute_role_can_edit(
        p_company, ordered.role_id, 'ops_workforce_payout_disputes'
      ) and (
        not coalesce(p_require_payout_edit, false)
        or public.workforce_payout_dispute_role_can_edit(
          p_company, ordered.role_id, 'ops_workforce_payouts'
        )
      ) as ops_ready
    from ordered_roles ordered
  ), capable_roles as (
    select capability.*
    from role_capabilities capability
    where capability.dashboard_ready or capability.ops_ready
  ), effective_position_access as (
    select
      assignment.profile_id,
      position.role_id,
      position.location_access_mode,
      position.location_scope_ids
    from public.org_positions position
    join public.position_assignments assignment
      on assignment.company_id = position.company_id
      and assignment.position_id = position.id
      and assignment.is_active
      and assignment.valid_from <= (clock_timestamp() at time zone 'Asia/Kolkata')::date
      and (
        assignment.valid_until is null
        or assignment.valid_until >= (clock_timestamp() at time zone 'Asia/Kolkata')::date
      )
    where position.company_id = p_company
      and position.is_active
  ), eligible_roles as (
    select capable.role_id, capable.priority
    from capable_roles capable
    where exists (
      select 1
      from public.profiles profile
      where profile.company_id = p_company
        and profile.is_active
        and not (profile.id = any(coalesce(p_excluded_profile_ids, '{}'::uuid[])))
        and (
          profile.role_id = capable.role_id
          or exists (
            select 1
            from effective_position_access candidate_position
            where candidate_position.profile_id = profile.id
              and candidate_position.role_id = capable.role_id
          )
        )
        and (
          p_station is null
          or capable.location_access_mode = 'all_locations'
          or p_station = any(coalesce(profile.location_scope_ids, '{}'::uuid[]))
          or exists (
            select 1
            from public.user_roles direct_role
            where direct_role.id = profile.role_id
              and direct_role.company_id = p_company
              and direct_role.is_active
              and direct_role.location_access_mode = 'all_locations'
          )
          or exists (
            select 1
            from effective_position_access scope_position
            where scope_position.profile_id = profile.id
              and (
                scope_position.location_access_mode = 'all_locations'
                or p_station = any(coalesce(scope_position.location_scope_ids, '{}'::uuid[]))
              )
          )
        )
        and (
          capable.dashboard_ready
          or (
            capable.ops_ready
            and not exists (
              select 1
              from public.company_product_memberships operations_membership
              where operations_membership.company_id = p_company
                and operations_membership.user_id = profile.id
                and operations_membership.product_code = 'operations'
                and operations_membership.is_active
            )
          )
        )
    )
    or exists (
      select 1
      from public.company_product_memberships membership
      join public.profiles profile
        on profile.id = membership.user_id
        and profile.company_id = membership.company_id
        and profile.is_active
      where membership.company_id = p_company
        and membership.role_id = capable.role_id
        and membership.product_code = 'operations'
        and membership.is_active
        and not (profile.id = any(coalesce(p_excluded_profile_ids, '{}'::uuid[])))
        and capable.ops_ready
        and (
          p_station is null
          or exists (
            -- Ops authorization combines location scope across every active
            -- Operations membership and treats any effective all-location
            -- role as authoritative. Route eligibility must use that same
            -- effective scope, not only the row for the candidate role.
            select 1
            from public.company_product_memberships scope_membership
            join public.user_roles scope_role
              on scope_role.id = scope_membership.role_id
              and scope_role.company_id = scope_membership.company_id
              and scope_role.is_active
            where scope_membership.company_id = p_company
              and scope_membership.user_id = profile.id
              and scope_membership.product_code = 'operations'
              and scope_membership.is_active
              and (
                scope_membership.has_all_location_access
                or scope_role.location_access_mode = 'all_locations'
                or p_station = any(coalesce(scope_membership.location_scope_ids, '{}'::uuid[]))
              )
          )
        )
    )
  )
  select eligible.role_id
  from eligible_roles eligible
  order by eligible.priority
  limit 1
$function$;

revoke all on function public.workforce_payout_dispute_first_eligible_role(
  uuid, uuid, uuid[], boolean, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_payout_dispute_first_eligible_role(
  uuid, uuid, uuid[], boolean, uuid[]
) to service_role;

create or replace function public.workforce_upsert_dispute_workflow(
  p_company uuid,
  p_station uuid,
  p_initial_role_ids uuid[],
  p_final_role_ids uuid[],
  p_processor_role_ids uuid[],
  p_actor uuid,
  p_expected_version integer default null,
  p_is_active boolean default true
)
returns public.workforce_payout_dispute_workflows
language plpgsql
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_dispute_workflows;
  v_saved public.workforce_payout_dispute_workflows;
begin
  if p_company is null or p_actor is null then
    raise exception 'Company and actor are required.';
  end if;

  select workflow.* into v_existing
  from public.workforce_payout_dispute_workflows workflow
  where workflow.company_id = p_company
    and workflow.station_id is not distinct from p_station
  for update;

  if found then
    if p_expected_version is null or p_expected_version <> v_existing.version then
      raise exception 'The workflow changed after you opened it. Refresh and try again.';
    end if;
    update public.workforce_payout_dispute_workflows
    set initial_approver_role_ids = p_initial_role_ids,
        final_approver_role_ids = p_final_role_ids,
        processor_role_ids = p_processor_role_ids,
        is_active = coalesce(p_is_active, true),
        updated_by = p_actor
    where id = v_existing.id
    returning * into v_saved;
  else
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'The workflow changed after you opened it. Refresh and try again.';
    end if;
    insert into public.workforce_payout_dispute_workflows(
      company_id, station_id, initial_approver_role_ids, final_approver_role_ids,
      processor_role_ids, is_active, created_by, updated_by
    ) values (
      p_company, p_station, p_initial_role_ids, p_final_role_ids,
      p_processor_role_ids, coalesce(p_is_active, true), p_actor, p_actor
    ) returning * into v_saved;
  end if;
  return v_saved;
end
$function$;

revoke all on function public.workforce_upsert_dispute_workflow(
  uuid, uuid, uuid[], uuid[], uuid[], uuid, integer, boolean
) from public, anon, authenticated;
grant execute on function public.workforce_upsert_dispute_workflow(
  uuid, uuid, uuid[], uuid[], uuid[], uuid, integer, boolean
) to service_role;

alter table public.workforce_payout_disputes
  add column if not exists version integer not null default 1,
  add column if not exists correction_plan jsonb,
  add column if not exists workflow_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists initial_reviewed_by uuid,
  add column if not exists initial_reviewed_by_name text,
  add column if not exists initial_reviewed_at timestamptz,
  add column if not exists final_approved_by uuid,
  add column if not exists final_approved_by_name text,
  add column if not exists final_approved_at timestamptz,
  add column if not exists processor_id uuid,
  add column if not exists processor_name text,
  add column if not exists processor_claimed_at timestamptz,
  add column if not exists processing_note text,
  add column if not exists processing_result jsonb,
  add column if not exists processed_publication_id uuid,
  add column if not exists processed_at timestamptz,
  add column if not exists legacy_resolution_unverified boolean not null default false;

do $block$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workforce_payout_disputes'::regclass
      and conname = 'workforce_payout_disputes_processed_publication_fk'
  ) then
    alter table public.workforce_payout_disputes
      add constraint workforce_payout_disputes_processed_publication_fk
      foreign key (processed_publication_id)
      references public.workforce_payout_publications(id)
      on delete restrict;
  end if;
end
$block$;

alter table public.workforce_payout_disputes
  drop constraint if exists workforce_payout_disputes_status_check,
  drop constraint if exists workforce_payout_disputes_version_check,
  drop constraint if exists workforce_payout_disputes_correction_plan_check,
  drop constraint if exists workforce_payout_disputes_workflow_snapshot_check,
  drop constraint if exists workforce_payout_disputes_processing_result_check;

alter table public.workforce_payout_disputes
  add constraint workforce_payout_disputes_status_check check (status in (
    'open', 'in_review', 'pending_final_approval', 'approved_for_processing',
    'processing', 'processing_blocked', 'resolved', 'rejected'
  )) not valid,
  add constraint workforce_payout_disputes_version_check check (version > 0) not valid,
  add constraint workforce_payout_disputes_correction_plan_check check (
    correction_plan is null or jsonb_typeof(correction_plan) = 'object'
  ) not valid,
  add constraint workforce_payout_disputes_workflow_snapshot_check check (
    jsonb_typeof(workflow_snapshot) = 'object'
  ) not valid,
  add constraint workforce_payout_disputes_processing_result_check check (
    processing_result is null or jsonb_typeof(processing_result) = 'object'
  ) not valid;

-- Migrate only legacy records that existed before this workflow. A rerun does not relabel a v2 result.
update public.workforce_payout_disputes dispute
set status = 'pending_final_approval',
    correction_plan = case
      when dispute.proposed_decision = 'resolved' then jsonb_build_object(
        'kind', 'other',
        'target_field', 'legacy_manual_review',
        'current_value', null,
        'proposed_value', null,
        'expected_delta_paise', null,
        'note', coalesce(dispute.proposed_note, 'Legacy correction proposal'),
        'legacy', true
      )
      else null
    end,
    workflow_snapshot = jsonb_build_object(
      'legacy', true,
      'migration', '20261020100000',
      'requires_current_workflow', true
    ),
    initial_reviewed_by = coalesce(dispute.initial_reviewed_by, dispute.proposed_by),
    initial_reviewed_by_name = coalesce(dispute.initial_reviewed_by_name, dispute.proposed_by_name),
    initial_reviewed_at = coalesce(dispute.initial_reviewed_at, dispute.proposed_at),
    version = greatest(dispute.version, 1),
    updated_at = clock_timestamp()
where dispute.status = 'in_review'
  and coalesce(dispute.workflow_snapshot, '{}'::jsonb) = '{}'::jsonb;

update public.workforce_payout_disputes dispute
set legacy_resolution_unverified = true,
    workflow_snapshot = jsonb_build_object(
      'legacy', true,
      'migration', '20261020100000',
      'resolution_verified', false
    )
where dispute.status in ('resolved', 'rejected')
  and coalesce(dispute.workflow_snapshot, '{}'::jsonb) = '{}'::jsonb;

alter table public.workforce_payout_disputes
  validate constraint workforce_payout_disputes_status_check;
alter table public.workforce_payout_disputes
  validate constraint workforce_payout_disputes_version_check;
alter table public.workforce_payout_disputes
  validate constraint workforce_payout_disputes_correction_plan_check;
alter table public.workforce_payout_disputes
  validate constraint workforce_payout_disputes_workflow_snapshot_check;
alter table public.workforce_payout_disputes
  validate constraint workforce_payout_disputes_processing_result_check;

drop index if exists public.workforce_payout_disputes_open_category_uidx;
create unique index workforce_payout_disputes_open_category_uidx
  on public.workforce_payout_disputes(publication_id, category)
  where status in (
    'open', 'in_review', 'pending_final_approval', 'approved_for_processing',
    'processing', 'processing_blocked'
  );
create index if not exists workforce_payout_disputes_processing_queue_idx
  on public.workforce_payout_disputes(company_id, status, station_id, updated_at)
  where status in ('approved_for_processing', 'processing', 'processing_blocked');

alter table public.workforce_payout_dispute_events
  add column if not exists event_type text not null default 'legacy_note',
  add column if not exists from_status text,
  add column if not exists to_status text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists dispute_version integer;

alter table public.workforce_payout_dispute_events
  drop constraint if exists workforce_payout_dispute_events_metadata_check,
  drop constraint if exists workforce_payout_dispute_events_version_check;
alter table public.workforce_payout_dispute_events
  add constraint workforce_payout_dispute_events_metadata_check
    check (jsonb_typeof(metadata) = 'object') not valid,
  add constraint workforce_payout_dispute_events_version_check
    check (dispute_version is null or dispute_version > 0) not valid;
alter table public.workforce_payout_dispute_events
  validate constraint workforce_payout_dispute_events_metadata_check;
alter table public.workforce_payout_dispute_events
  validate constraint workforce_payout_dispute_events_version_check;
create unique index if not exists workforce_payout_dispute_events_version_uidx
  on public.workforce_payout_dispute_events(dispute_id, dispute_version)
  where dispute_version is not null;

create or replace function public.reject_workforce_payout_dispute_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Payout dispute history is immutable.';
end
$function$;

drop trigger if exists workforce_payout_dispute_events_immutable
  on public.workforce_payout_dispute_events;
create trigger workforce_payout_dispute_events_immutable
before update or delete on public.workforce_payout_dispute_events
for each row execute function public.reject_workforce_payout_dispute_event_mutation();

-- Resolve all action routes shown on a review-desk page in one service-role call.
-- Each request is { "dispute_id": "...", "stage": "initial|final|processor" }.
-- The result intentionally includes a row with a null role when no candidate is
-- currently eligible, allowing the UI to fail closed without duplicating routing
-- rules or making one database round trip per dispute.
create or replace function public.workforce_payout_dispute_route_roles(
  p_company uuid,
  p_requests jsonb
)
returns table (
  dispute_id uuid,
  stage text,
  role_id uuid
)
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_request jsonb;
  v_dispute public.workforce_payout_disputes;
  v_dispute_id uuid;
  v_stage text;
  v_role_key text;
  v_snapshot jsonb;
  v_stage_role_ids uuid[];
  v_excluded_actor_ids uuid[];
begin
  if p_company is null then
    raise exception 'Company is required.';
  end if;
  if jsonb_typeof(coalesce(p_requests, '[]'::jsonb)) <> 'array' then
    raise exception 'Route requests must be a JSON array.';
  end if;
  if jsonb_array_length(coalesce(p_requests, '[]'::jsonb)) > 500 then
    raise exception 'Resolve at most 500 dispute routes at a time.';
  end if;

  for v_request in
    select request.value from jsonb_array_elements(coalesce(p_requests, '[]'::jsonb)) request(value)
  loop
    begin
      v_dispute_id := (v_request ->> 'dispute_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Every route request requires a valid dispute ID.';
    end;
    v_stage := lower(coalesce(v_request ->> 'stage', ''));
    v_role_key := case v_stage
      when 'initial' then 'initial_approver_role_ids'
      when 'final' then 'final_approver_role_ids'
      when 'processor' then 'processor_role_ids'
      else null
    end;
    if v_dispute_id is null or v_role_key is null then
      raise exception 'Every route request requires a dispute ID and initial, final or processor stage.';
    end if;

    select dispute.* into v_dispute
    from public.workforce_payout_disputes dispute
    where dispute.id = v_dispute_id
      and dispute.company_id = p_company;
    if not found then
      continue;
    end if;

    v_snapshot := v_dispute.workflow_snapshot;
    if v_snapshot is null
      or jsonb_typeof(v_snapshot) is distinct from 'object'
      or jsonb_typeof(v_snapshot -> v_role_key) is distinct from 'array'
    then
      v_snapshot := public.workforce_payout_dispute_workflow_snapshot(
        p_company,
        v_dispute.station_id
      );
    end if;

    v_stage_role_ids := '{}'::uuid[];
    if v_snapshot is not null and jsonb_typeof(v_snapshot -> v_role_key) = 'array' then
      select coalesce(array_agg(configured.role_id::uuid order by configured.priority), '{}'::uuid[])
      into v_stage_role_ids
      from jsonb_array_elements_text(v_snapshot -> v_role_key) with ordinality
        configured(role_id, priority);
    end if;

    v_excluded_actor_ids := case v_stage
      when 'final' then array_remove(array[
        v_dispute.initial_reviewed_by,
        v_dispute.proposed_by
      ]::uuid[], null)
      when 'processor' then array_remove(array[
        v_dispute.initial_reviewed_by,
        v_dispute.proposed_by,
        v_dispute.final_approved_by
      ]::uuid[], null)
      else '{}'::uuid[]
    end;

    dispute_id := v_dispute.id;
    stage := v_stage;
    role_id := public.workforce_payout_dispute_first_eligible_role(
      p_company,
      v_dispute.station_id,
      v_stage_role_ids,
      v_stage = 'processor',
      v_excluded_actor_ids
    );
    return next;
  end loop;
end
$function$;

revoke all on function public.workforce_payout_dispute_route_roles(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.workforce_payout_dispute_route_roles(uuid, jsonb)
  to service_role;

create or replace function public.workforce_dispute_transition_v2(
  p_company uuid,
  p_dispute uuid,
  p_actor uuid,
  p_actor_name text,
  p_actor_role_ids uuid[],
  p_action text,
  p_expected_version integer,
  p_locations uuid[],
  p_payload jsonb default '{}'::jsonb
)
returns public.workforce_payout_disputes
language plpgsql
set search_path = ''
as $function$
declare
  v_dispute public.workforce_payout_disputes;
  v_saved public.workforce_payout_disputes;
  v_snapshot jsonb;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_plan jsonb;
  v_result jsonb;
  v_note text;
  v_name text := coalesce(nullif(btrim(p_actor_name), ''), 'Authorised user');
  v_role_key text;
  v_from_status text;
  v_event_message text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_portal text;
  v_processed_publication uuid;
  v_source_period_start date;
  v_source_period_end date;
  v_source_revision integer;
  v_source_published_at timestamptz;
  v_source_net_text text;
  v_new_period_start date;
  v_new_period_end date;
  v_new_revision integer;
  v_new_published_at timestamptz;
  v_new_net_text text;
  v_before_paise bigint;
  v_after_paise bigint;
  v_expected_delta bigint;
  v_stage_role_ids uuid[];
  v_required_role uuid;
  v_excluded_actor_ids uuid[] := '{}'::uuid[];
  v_now timestamptz;
begin
  if p_company is null or p_dispute is null or p_actor is null then
    raise exception 'Company, dispute and actor are required.';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Transition details must be a JSON object.';
  end if;
  if p_expected_version is null then
    raise exception 'The dispute version is required.';
  end if;

  select dispute.* into v_dispute
  from public.workforce_payout_disputes dispute
  where dispute.id = p_dispute and dispute.company_id = p_company
  for update;
  if not found then raise exception 'Dispute was not found.'; end if;
  if p_locations is not null and not coalesce(v_dispute.station_id = any(p_locations), false) then
    raise exception 'Dispute is outside your station scope.';
  end if;
  if v_dispute.version <> p_expected_version then
    raise exception 'The dispute changed after you opened it. Refresh and try again.';
  end if;

  v_from_status := v_dispute.status;
  v_note := nullif(btrim(coalesce(v_payload ->> 'note', '')), '');
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'Keep the note under 1,000 characters.';
  end if;
  v_portal := case lower(coalesce(v_payload ->> 'portal', 'workforce'))
    when 'ops' then 'ops' else 'workforce' end;

  if p_action in ('propose_correction', 'propose_rejection') then
    if v_dispute.status <> 'open' then
      raise exception 'This dispute is already %.', replace(v_dispute.status, '_', ' ');
    end if;
    v_role_key := 'initial_approver_role_ids';
    v_snapshot := public.workforce_payout_dispute_workflow_snapshot(p_company, v_dispute.station_id);
  elsif p_action in ('approve_final', 'send_back') then
    if v_dispute.status not in ('pending_final_approval', 'in_review') then
      raise exception 'This dispute is not waiting for final approval.';
    end if;
    v_role_key := 'final_approver_role_ids';
    v_snapshot := v_dispute.workflow_snapshot;
  elsif p_action in ('claim_processing', 'block_processing', 'complete_processing') then
    v_role_key := 'processor_role_ids';
    v_snapshot := v_dispute.workflow_snapshot;
  else
    raise exception 'Unknown dispute action.';
  end if;

  -- Legacy in-flight reviews did not have a workflow snapshot. Bind them to the current route once.
  if v_snapshot is null
    or jsonb_typeof(v_snapshot) is distinct from 'object'
    or jsonb_typeof(v_snapshot -> v_role_key) is distinct from 'array'
  then
    v_snapshot := public.workforce_payout_dispute_workflow_snapshot(p_company, v_dispute.station_id);
  end if;
  if v_snapshot is null then
    raise exception 'No active payout dispute workflow is configured for this station.';
  end if;
  select coalesce(array_agg(configured.role_id::uuid order by configured.priority), '{}'::uuid[])
  into v_stage_role_ids
  from jsonb_array_elements_text(v_snapshot -> v_role_key) with ordinality
    configured(role_id, priority);

  -- Claiming is routed to the first currently eligible processor role. Once a
  -- person has claimed the task, that person retains it even if role coverage
  -- changes before they record a blocker or complete the correction.
  if p_action not in ('block_processing', 'complete_processing') then
    v_excluded_actor_ids := case
      when v_role_key = 'final_approver_role_ids' then array_remove(array[
        v_dispute.initial_reviewed_by,
        v_dispute.proposed_by
      ]::uuid[], null)
      when v_role_key = 'processor_role_ids' then array_remove(array[
        v_dispute.initial_reviewed_by,
        v_dispute.proposed_by,
        v_dispute.final_approved_by
      ]::uuid[], null)
      else '{}'::uuid[]
    end;
    v_required_role := public.workforce_payout_dispute_first_eligible_role(
      p_company,
      v_dispute.station_id,
      v_stage_role_ids,
      v_role_key = 'processor_role_ids',
      v_excluded_actor_ids
    );
    if v_required_role is null then
      raise exception 'No active permitted user is available for this dispute stage.';
    end if;
    if not (v_required_role = any(coalesce(p_actor_role_ids, '{}'::uuid[]))) then
      raise exception 'Your role is not configured as the active primary or fallback role for this dispute stage.';
    end if;
  end if;

  if p_action = 'propose_correction' then
    if v_note is null or length(v_note) < 10 then
      raise exception 'Explain the proposed correction (at least 10 characters).';
    end if;
    v_plan := v_payload -> 'correction_plan';
    if jsonb_typeof(v_plan) <> 'object'
      or coalesce(v_plan ->> 'kind', '') not in (
        'attendance', 'workdays', 'production', 'payment_rate',
        'additional_payment', 'deduction', 'other'
      )
      or nullif(btrim(coalesce(v_plan ->> 'target_field', '')), '') is null
      or not (v_plan ? 'current_value')
      or not (v_plan ? 'proposed_value')
      or coalesce(v_plan ->> 'expected_delta_paise', '') !~ '^-?[0-9]+$'
    then
      raise exception 'Provide a structured correction plan with kind, field, current value, proposed value and expected net difference.';
    end if;
    if v_plan ? 'expected_delta_paise'
      and jsonb_typeof(v_plan -> 'expected_delta_paise') <> 'null'
      and coalesce(v_plan ->> 'expected_delta_paise', '') !~ '^-?[0-9]+$'
    then
      raise exception 'Expected payout difference must be whole paise.';
    end if;
    update public.workforce_payout_disputes
    set status = 'pending_final_approval',
        proposed_decision = 'resolved',
        proposed_note = v_note,
        proposed_by = p_actor,
        proposed_by_name = v_name,
        proposed_at = clock_timestamp(),
        correction_plan = v_plan || jsonb_build_object('note', v_note),
        workflow_snapshot = v_snapshot,
        initial_reviewed_by = p_actor,
        initial_reviewed_by_name = v_name,
        initial_reviewed_at = clock_timestamp(),
        legacy_resolution_unverified = false,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Correction proposed: ' || v_note;
    v_event_metadata := jsonb_build_object('correction_plan', v_saved.correction_plan);

  elsif p_action = 'propose_rejection' then
    if v_note is null or length(v_note) < 10 then
      raise exception 'Explain the proposed rejection (at least 10 characters).';
    end if;
    update public.workforce_payout_disputes
    set status = 'pending_final_approval',
        proposed_decision = 'rejected',
        proposed_note = v_note,
        proposed_by = p_actor,
        proposed_by_name = v_name,
        proposed_at = clock_timestamp(),
        correction_plan = null,
        workflow_snapshot = v_snapshot,
        initial_reviewed_by = p_actor,
        initial_reviewed_by_name = v_name,
        initial_reviewed_at = clock_timestamp(),
        legacy_resolution_unverified = false,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Rejection proposed: ' || v_note;

  elsif p_action = 'approve_final' then
    if v_dispute.initial_reviewed_by = p_actor or v_dispute.proposed_by = p_actor then
      raise exception 'A different person must give final approval.';
    end if;
    if v_dispute.proposed_decision = 'resolved' and v_dispute.correction_plan is null then
      raise exception 'A correction plan is required before final approval.';
    end if;
    if v_dispute.proposed_decision = 'resolved'
      and coalesce(v_dispute.correction_plan ->> 'expected_delta_paise', '') !~ '^-?[0-9]+$'
    then
      raise exception 'Send this proposal back so the initial approver can record the exact expected net difference.';
    end if;
    if v_dispute.proposed_decision not in ('resolved', 'rejected') then
      raise exception 'There is no proposed decision to approve.';
    end if;
    update public.workforce_payout_disputes
    set status = case when v_dispute.proposed_decision = 'rejected'
          then 'rejected' else 'approved_for_processing' end,
        workflow_snapshot = v_snapshot,
        final_approved_by = p_actor,
        final_approved_by_name = v_name,
        final_approved_at = clock_timestamp(),
        approved_by_name = v_name,
        resolution = case when v_dispute.proposed_decision = 'rejected'
          then v_dispute.proposed_note else null end,
        resolved_by = case when v_dispute.proposed_decision = 'rejected'
          then p_actor else null end,
        resolved_at = case when v_dispute.proposed_decision = 'rejected'
          then clock_timestamp() else null end,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := case when v_dispute.proposed_decision = 'rejected'
      then 'Final approval: dispute rejected.'
      else 'Final approval: correction approved for processing.' end;
    v_event_metadata := jsonb_strip_nulls(jsonb_build_object('note', v_note));

  elsif p_action = 'send_back' then
    if v_dispute.initial_reviewed_by = p_actor or v_dispute.proposed_by = p_actor then
      raise exception 'A different person must review or send back the proposal.';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Say why the proposal is being sent back (at least 5 characters).';
    end if;
    update public.workforce_payout_disputes
    set status = 'open',
        proposed_decision = null,
        proposed_note = null,
        proposed_by = null,
        proposed_by_name = null,
        proposed_at = null,
        correction_plan = null,
        workflow_snapshot = v_snapshot,
        initial_reviewed_by = null,
        initial_reviewed_by_name = null,
        initial_reviewed_at = null,
        final_approved_by = null,
        final_approved_by_name = null,
        final_approved_at = null,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Sent back for initial review: ' || v_note;

  elsif p_action = 'claim_processing' then
    if v_dispute.status not in ('approved_for_processing', 'processing_blocked') then
      raise exception 'This dispute is not available for processing.';
    end if;
    if p_actor in (v_dispute.initial_reviewed_by, v_dispute.final_approved_by) then
      raise exception 'The processor must be different from both approvers.';
    end if;
    select
      coalesce(source.period_start, source_run.period_start),
      coalesce(source.period_end, source_run.period_end)
    into v_source_period_start, v_source_period_end
    from public.workforce_payout_publications source
    left join public.workforce_payroll_runs source_run on source_run.id = source.payroll_run_id
    where source.id = v_dispute.publication_id
      and source.company_id = p_company
      and source.workforce_id = v_dispute.workforce_id
      and source.station_id = v_dispute.station_id;
    if v_source_period_start is null or v_source_period_end is null then
      raise exception 'The disputed payout period could not be verified.';
    end if;
    if exists (
      select 1
      from public.workforce_payout_payment_items payment_item
      where payment_item.company_id = p_company
        and payment_item.workforce_id = v_dispute.workforce_id
        and payment_item.location_id_snapshot = v_dispute.station_id
        and payment_item.status = 'processing'
        and daterange(payment_item.period_start, payment_item.period_end, '[]')
          && daterange(v_source_period_start, v_source_period_end, '[]')
    ) then
      raise exception 'This payout is still in bank processing. Finalize or cancel the bank instruction before claiming the correction.';
    end if;
    update public.workforce_payout_disputes
    set status = 'processing',
        workflow_snapshot = v_snapshot,
        processor_id = p_actor,
        processor_name = v_name,
        processor_claimed_at = clock_timestamp(),
        processing_note = v_note,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Processing claimed by ' || v_name || '.';

  elsif p_action = 'block_processing' then
    if v_dispute.status <> 'processing' or v_dispute.processor_id <> p_actor then
      raise exception 'Only the assigned processor can block this processing task.';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Explain what is blocking the correction (at least 5 characters).';
    end if;
    update public.workforce_payout_disputes
    set status = 'processing_blocked',
        processing_note = v_note,
        version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Processing blocked: ' || v_note;

  elsif p_action = 'complete_processing' then
    if v_dispute.status <> 'processing' or v_dispute.processor_id <> p_actor then
      raise exception 'Only the assigned processor can complete this processing task.';
    end if;
    if v_note is null or length(v_note) < 10 then
      raise exception 'Explain the completed correction for the associate (at least 10 characters).';
    end if;
    begin
      v_processed_publication := (v_payload ->> 'processed_publication_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Select the revised payout publication.';
    end;
    v_result := v_payload -> 'processing_result';
    if v_processed_publication is null
      or jsonb_typeof(v_result) <> 'object'
      or coalesce(v_result ->> 'before_net_paise', '') !~ '^-?[0-9]+$'
      or coalesce(v_result ->> 'after_net_paise', '') !~ '^-?[0-9]+$'
    then
      raise exception 'Completion requires the revised publication and before/after net pay in paise.';
    end if;

    select
      coalesce(source.period_start, source_run.period_start),
      coalesce(source.period_end, source_run.period_end),
      source.revision,
      source.published_at,
      source.snapshot #>> '{item,net_amount}'
    into v_source_period_start, v_source_period_end, v_source_revision,
      v_source_published_at, v_source_net_text
    from public.workforce_payout_publications source
    left join public.workforce_payroll_runs source_run on source_run.id = source.payroll_run_id
    where source.id = v_dispute.publication_id
      and source.company_id = p_company
      and source.workforce_id = v_dispute.workforce_id
      and source.station_id = v_dispute.station_id;
    if not found then raise exception 'The disputed payout publication was not found.'; end if;

    select
      coalesce(revised.period_start, revised_run.period_start),
      coalesce(revised.period_end, revised_run.period_end),
      revised.revision,
      revised.published_at,
      revised.snapshot #>> '{item,net_amount}'
    into v_new_period_start, v_new_period_end, v_new_revision,
      v_new_published_at, v_new_net_text
    from public.workforce_payout_publications revised
    left join public.workforce_payroll_runs revised_run on revised_run.id = revised.payroll_run_id
    where revised.id = v_processed_publication
      and revised.company_id = p_company
      and revised.workforce_id = v_dispute.workforce_id
      and revised.station_id = v_dispute.station_id;
    if not found then raise exception 'The revised publication is for a different person or station.'; end if;
    if v_source_period_start is null or v_source_period_end is null
      or v_new_period_start <> v_source_period_start
      or v_new_period_end <> v_source_period_end
      or v_new_revision <= v_source_revision
      or v_new_published_at <= v_source_published_at
      or v_new_published_at <= coalesce(v_dispute.processor_claimed_at, v_dispute.final_approved_at)
    then
      raise exception 'Completion requires a publication created after this processing task was claimed, for the same person, station and payout period.';
    end if;
    if coalesce(v_source_net_text, '') !~ '^[+-]?[0-9]+([.][0-9]+)?$'
      or coalesce(v_new_net_text, '') !~ '^[+-]?[0-9]+([.][0-9]+)?$'
    then
      raise exception 'The original and revised publications must contain valid net pay.';
    end if;

    v_before_paise := round(v_source_net_text::numeric * 100, 0)::bigint;
    v_after_paise := round(v_new_net_text::numeric * 100, 0)::bigint;
    if (v_result ->> 'before_net_paise')::bigint <> v_before_paise
      or (v_result ->> 'after_net_paise')::bigint <> v_after_paise
    then
      raise exception 'The entered before/after amount does not match the linked payout publications.';
    end if;
    if v_dispute.correction_plan ? 'expected_delta_paise'
      and jsonb_typeof(v_dispute.correction_plan -> 'expected_delta_paise') <> 'null'
    then
      v_expected_delta := (v_dispute.correction_plan ->> 'expected_delta_paise')::bigint;
      if v_after_paise - v_before_paise <> v_expected_delta then
        raise exception 'The revised payout difference does not match the final-approved correction.';
      end if;
    end if;

    v_now := clock_timestamp();
    v_result := v_result || jsonb_build_object(
      'verified_before_net_paise', v_before_paise,
      'verified_after_net_paise', v_after_paise,
      'verified_delta_paise', v_after_paise - v_before_paise,
      'verified_at', v_now,
      'publication_net_change_verified', true,
      'field_change_attested_by', p_actor,
      'field_change_attested_at', v_now
    );
    update public.workforce_payout_disputes
    set status = 'resolved',
        resolution = v_note,
        resolved_by = p_actor,
        resolved_at = v_now,
        processing_note = v_note,
        processing_result = v_result,
        processed_publication_id = v_processed_publication,
        processed_at = v_now,
        legacy_resolution_unverified = false,
        version = v_dispute.version + 1,
        updated_at = v_now
    where id = v_dispute.id
    returning * into v_saved;
    v_event_message := 'Processor-applied correction completed; revised publication and net change system-verified: ' || v_note;
    v_event_metadata := jsonb_build_object(
      'processed_publication_id', v_processed_publication,
      'processing_result', v_result
    );
  end if;

  insert into public.workforce_payout_dispute_events(
    company_id, dispute_id, actor_id, actor_name, portal, message,
    event_type, from_status, to_status, metadata, dispute_version
  ) values (
    p_company, v_dispute.id, p_actor, v_name, v_portal, v_event_message,
    p_action, v_from_status, v_saved.status, v_event_metadata, v_saved.version
  );
  return v_saved;
end
$function$;

revoke all on function public.workforce_dispute_transition_v2(
  uuid, uuid, uuid, text, uuid[], text, integer, uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.workforce_dispute_transition_v2(
  uuid, uuid, uuid, text, uuid[], text, integer, uuid[], jsonb
) to service_role;

-- The legacy one-step decision function can bypass the independent approval
-- and processor stages. It is kept in place for rollback compatibility but is
-- no longer executable by the application service role.
do $block$
begin
  if to_regprocedure(
    'public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[])'
  ) is not null then
    execute 'revoke all on function public.workforce_decide_payout_dispute(uuid,uuid,uuid,text,text,uuid[]) from service_role';
  end if;
end
$block$;

-- Rolling-deployment adapter for the old two-reviewer screen. It preserves the old signature but a
-- correction approval now enters processing instead of falsely resolving the associate's dispute.
create or replace function public.workforce_dispute_step(
  p_company uuid,
  p_dispute uuid,
  p_actor uuid,
  p_actor_name text,
  p_step text,
  p_decision text,
  p_note text,
  p_locations uuid[]
)
returns public.workforce_payout_disputes
language plpgsql
set search_path = ''
as $function$
declare
  v_dispute public.workforce_payout_disputes;
  v_saved public.workforce_payout_disputes;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_name text := coalesce(nullif(btrim(p_actor_name), ''), 'Authorised reviewer');
  v_message text;
  v_snapshot jsonb;
begin
  select dispute.* into v_dispute
  from public.workforce_payout_disputes dispute
  where dispute.id = p_dispute and dispute.company_id = p_company
  for update;
  if not found or p_actor is null
    or (p_locations is not null and not coalesce(v_dispute.station_id = any(p_locations), false))
  then raise exception 'Dispute is outside your scope'; end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'Keep the note under 1,000 characters.';
  end if;
  v_snapshot := public.workforce_payout_dispute_workflow_snapshot(p_company, v_dispute.station_id);
  if v_snapshot is null then
    v_snapshot := jsonb_build_object('legacy_adapter', true, 'requires_current_workflow', true);
  end if;

  if p_step = 'propose' then
    if v_dispute.status <> 'open' then
      raise exception 'This dispute is already %.', replace(v_dispute.status, '_', ' ');
    end if;
    if p_decision not in ('resolved', 'rejected') then raise exception 'Choose Resolve or Reject.'; end if;
    if v_note is null or length(v_note) < 10 then
      raise exception 'Explain the decision for the associate (at least 10 characters).';
    end if;
    update public.workforce_payout_disputes
    set status = 'in_review', proposed_decision = p_decision, proposed_note = v_note,
        proposed_by = p_actor, proposed_by_name = v_name, proposed_at = clock_timestamp(),
        correction_plan = case when p_decision = 'resolved' then jsonb_build_object(
          'kind', 'other', 'target_field', 'legacy_manual_review',
          'current_value', null, 'proposed_value', null,
          'expected_delta_paise', null, 'note', v_note, 'legacy', true
        ) else null end,
        workflow_snapshot = v_snapshot,
        initial_reviewed_by = p_actor, initial_reviewed_by_name = v_name,
        initial_reviewed_at = clock_timestamp(), version = v_dispute.version + 1,
        updated_at = clock_timestamp()
    where id = v_dispute.id returning * into v_saved;
    v_message := 'Proposed to ' || case p_decision when 'resolved' then 'correct' else 'reject' end || ': ' || v_note;
  elsif p_step in ('approve', 'send_back') then
    if v_dispute.status not in ('in_review', 'pending_final_approval')
      or v_dispute.proposed_decision is null
    then raise exception 'This dispute has no decision waiting for approval.'; end if;
    if coalesce(v_dispute.initial_reviewed_by, v_dispute.proposed_by) = p_actor then
      raise exception 'You proposed this decision, so another reviewer must approve it.';
    end if;
    if p_step = 'approve' then
      update public.workforce_payout_disputes
      set status = case when v_dispute.proposed_decision = 'rejected'
            then 'rejected' else 'approved_for_processing' end,
          resolution = case when v_dispute.proposed_decision = 'rejected'
            then v_dispute.proposed_note else null end,
          resolved_by = case when v_dispute.proposed_decision = 'rejected' then p_actor else null end,
          resolved_at = case when v_dispute.proposed_decision = 'rejected' then clock_timestamp() else null end,
          final_approved_by = p_actor, final_approved_by_name = v_name,
          final_approved_at = clock_timestamp(), approved_by_name = v_name,
          version = v_dispute.version + 1, updated_at = clock_timestamp()
      where id = v_dispute.id returning * into v_saved;
      v_message := case when v_dispute.proposed_decision = 'rejected'
        then 'Final approval: dispute rejected.'
        else 'Final approval: correction approved for processing.' end;
    else
      if v_note is null or length(v_note) < 5 then
        raise exception 'Say why it goes back (at least 5 characters).';
      end if;
      update public.workforce_payout_disputes
      set status = 'open', proposed_decision = null, proposed_note = null,
          proposed_by = null, proposed_by_name = null, proposed_at = null,
          correction_plan = null, initial_reviewed_by = null,
          initial_reviewed_by_name = null, initial_reviewed_at = null,
          version = v_dispute.version + 1, updated_at = clock_timestamp()
      where id = v_dispute.id returning * into v_saved;
      v_message := 'Sent back for review: ' || v_note;
    end if;
  else
    raise exception 'Unknown step.';
  end if;

  insert into public.workforce_payout_dispute_events(
    company_id, dispute_id, actor_id, actor_name, portal, message,
    event_type, from_status, to_status, metadata, dispute_version
  ) values (
    p_company, v_dispute.id, p_actor, v_name, 'workforce', v_message,
    'legacy_' || p_step, v_dispute.status, v_saved.status,
    jsonb_build_object('legacy_adapter', true), v_saved.version
  );
  return v_saved;
end
$function$;

revoke all on function public.workforce_dispute_step(uuid, uuid, uuid, text, text, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.workforce_dispute_step(uuid, uuid, uuid, text, text, text, text, uuid[])
  to service_role;

-- Keep the mature bank calculator and creator untouched. Small wrappers add the dispute rule around
-- those canonical functions, so later changes to their internal accounting cannot be overwritten by
-- this workflow migration.
create or replace function public.workforce_payout_dispute_blocks_bank_row(
  p_company_id uuid,
  p_workforce_id uuid,
  p_station_id uuid,
  p_period_start date,
  p_period_end date
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
    from public.workforce_payout_disputes dispute
    join public.workforce_payout_publications publication
      on publication.id = dispute.publication_id
     and publication.company_id = dispute.company_id
    left join public.workforce_payroll_runs payroll_run
      on payroll_run.id = publication.payroll_run_id
    where dispute.company_id = p_company_id
      and dispute.workforce_id = p_workforce_id
      and dispute.station_id = p_station_id
      and dispute.status in (
        'open', 'in_review', 'pending_final_approval', 'approved_for_processing',
        'processing', 'processing_blocked'
      )
      and coalesce(publication.period_start, payroll_run.period_start) = p_period_start
      and coalesce(publication.period_end, payroll_run.period_end) = p_period_end
  )
$function$;

revoke all on function public.workforce_payout_dispute_blocks_bank_row(
  uuid, uuid, uuid, date, date
) from public, anon, authenticated, service_role;

create or replace function public.workforce_payout_payment_row_candidates_with_disputes(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns table (
  workforce_id uuid,
  station_id uuid,
  dropx_id text,
  station_code text,
  current_target_amount numeric(14,2),
  paid_amount numeric(14,2),
  processing_amount numeric(14,2),
  balance_payable numeric(14,2),
  available_to_pay numeric(14,2),
  history_count integer,
  payment_status text,
  eligible boolean,
  eligibility_code text,
  eligibility_message text,
  publication_id uuid,
  publication_revision integer,
  mapping_relock_id uuid,
  publication_snapshot_hash text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    candidate.workforce_id,
    candidate.station_id,
    candidate.dropx_id,
    candidate.station_code,
    candidate.current_target_amount,
    candidate.paid_amount,
    candidate.processing_amount,
    candidate.balance_payable,
    candidate.available_to_pay,
    candidate.history_count,
    candidate.payment_status,
    case when dispute_state.blocked then false else candidate.eligible end,
    case when dispute_state.blocked then 'payout_dispute_open' else candidate.eligibility_code end,
    case when dispute_state.blocked
      then 'An open payout dispute must be completed or rejected before this row can enter a bank file.'
      else candidate.eligibility_message end,
    candidate.publication_id,
    candidate.publication_revision,
    candidate.mapping_relock_id,
    candidate.publication_snapshot_hash
  from public.workforce_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, p_rows
  ) candidate
  cross join lateral (
    select public.workforce_payout_dispute_blocks_bank_row(
      p_company_id,
      candidate.workforce_id,
      candidate.station_id,
      p_period_start,
      p_period_end
    ) as blocked
  ) dispute_state
  order by candidate.workforce_id, candidate.station_id
$function$;

revoke all on function public.workforce_payout_payment_row_candidates_with_disputes(
  uuid, date, date, jsonb
) from public, anon, authenticated, service_role;

-- The worksheet preview uses the dispute-aware wrapper. Its public contract and privileges remain the
-- same as the existing preview RPC.
create or replace function public.workforce_preview_payout_payment_rows(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns table (
  workforce_id uuid,
  station_id uuid,
  dropx_id text,
  current_target_amount numeric(14,2),
  paid_amount numeric(14,2),
  processing_amount numeric(14,2),
  balance_payable numeric(14,2),
  available_to_pay numeric(14,2),
  history_count integer,
  payment_status text,
  eligible boolean,
  eligibility_code text,
  eligibility_message text
)
language sql
security definer
stable
set search_path = ''
as $function$
  -- Keep the publication-refresh ledger enrichment installed by
  -- 20261012200000, then overlay only the row-specific dispute gate.
  with candidates as materialized (
    select candidate.*
    from public.workforce_payout_payment_row_candidates(
      p_company_id, p_period_start, p_period_end, p_rows
    ) candidate
  ), pending_rows as (
    select candidate.workforce_id, candidate.station_id
    from candidates candidate
    where candidate.eligibility_code = 'publication_refresh_pending'
  ), ledger_entries as (
    select
      effective.credited_workforce_id as workforce_id,
      effective.station_id,
      effective.payment_item_id,
      'paid'::text as status,
      round(sum(effective.instruction_amount_snapshot), 2) as amount
    from public.workforce_payout_effective_paid_allocations effective
    join pending_rows pending
      on pending.workforce_id = effective.credited_workforce_id
     and pending.station_id = effective.station_id
    where effective.company_id = p_company_id
      and effective.period_start = p_period_start
      and effective.period_end = p_period_end
    group by effective.credited_workforce_id, effective.station_id,
      effective.payment_item_id

    union all

    select
      item.workforce_id,
      allocation.station_id,
      item.id as payment_item_id,
      item.status,
      round(sum(allocation.instruction_amount_snapshot), 2) as amount
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
    join pending_rows pending
      on pending.workforce_id = item.workforce_id
     and pending.station_id = allocation.station_id
    where item.company_id = p_company_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
      and item.status <> 'paid'
    group by item.workforce_id, allocation.station_id, item.id, item.status
  ), processing_profiles as (
    select distinct item.workforce_id
    from public.workforce_payout_payment_items item
    join pending_rows pending
      on pending.workforce_id = item.workforce_id
    where item.company_id = p_company_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
      and item.status = 'processing'
  ), ledger as (
    select
      entry.workforce_id,
      entry.station_id,
      round(coalesce(sum(entry.amount) filter (where entry.status = 'paid'), 0), 2)
        as paid_amount,
      round(coalesce(sum(entry.amount) filter (where entry.status = 'processing'), 0), 2)
        as processing_amount,
      count(distinct entry.payment_item_id)::integer as history_count
    from ledger_entries entry
    group by entry.workforce_id, entry.station_id
  )
  select
    candidate.workforce_id,
    candidate.station_id,
    candidate.dropx_id,
    candidate.current_target_amount,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.paid_amount, 0)::numeric(14,2)
      else candidate.paid_amount
    end,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.processing_amount, 0)::numeric(14,2)
      else candidate.processing_amount
    end,
    candidate.balance_payable,
    candidate.available_to_pay,
    case when candidate.eligibility_code = 'publication_refresh_pending'
      then coalesce(ledger.history_count, 0)
      else candidate.history_count
    end,
    case
      when candidate.eligibility_code = 'publication_refresh_pending'
        and processing_profile.workforce_id is not null
      then 'Payment Processing'
      else candidate.payment_status
    end,
    case when dispute_state.blocked then false else candidate.eligible end,
    case when dispute_state.blocked then 'payout_dispute_open' else candidate.eligibility_code end,
    case when dispute_state.blocked
      then 'An open payout dispute must be completed or rejected before this row can enter a bank file.'
      else candidate.eligibility_message end
  from candidates candidate
  left join ledger
    on ledger.workforce_id = candidate.workforce_id
   and ledger.station_id = candidate.station_id
  left join processing_profiles processing_profile
    on processing_profile.workforce_id = candidate.workforce_id
  cross join lateral (
    select public.workforce_payout_dispute_blocks_bank_row(
      p_company_id,
      candidate.workforce_id,
      candidate.station_id,
      p_period_start,
      p_period_end
    ) as blocked
  ) dispute_state
  order by candidate.workforce_id, candidate.station_id
$function$;

revoke all on function public.workforce_preview_payout_payment_rows(
  uuid, date, date, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_preview_payout_payment_rows(
  uuid, date, date, jsonb
) to service_role;

-- The route calls this wrapper instead of the canonical creator. Only rows blocked by an open dispute
-- are removed; every other row reaches the canonical preflight unchanged, preserving all of its
-- validation, locking, idempotency, accounting and audit behaviour.
create or replace function public.workforce_create_payout_payment_row_batch_with_disputes(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_request_fingerprint text,
  p_bank_id uuid,
  p_period_start date,
  p_period_end date,
  p_value_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
  v_skipped_rows jsonb := '[]'::jsonb;
  v_skipped_count integer := 0;
  v_effective_fingerprint text := p_request_fingerprint;
  v_result jsonb;
begin
  -- Preserve the canonical creator's exact validation messages for malformed or duplicate selections.
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return public.workforce_create_payout_payment_row_batch(
      p_company_id, p_actor_user_id, p_operation_id, p_request_fingerprint,
      p_bank_id, p_period_start, p_period_end, p_value_date, p_rows
    );
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    return public.workforce_create_payout_payment_row_batch(
      p_company_id, p_actor_user_id, p_operation_id, p_request_fingerprint,
      p_bank_id, p_period_start, p_period_end, p_value_date, p_rows
    );
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(selected.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) or exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then
    return public.workforce_create_payout_payment_row_batch(
      p_company_id, p_actor_user_id, p_operation_id, p_request_fingerprint,
      p_bank_id, p_period_start, p_period_end, p_value_date, p_rows
    );
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'workforce_id', (selected.value ->> 'workforce_id')::uuid,
      'station_id', (selected.value ->> 'station_id')::uuid
    ) order by selected.position)
      filter (where not selected.blocked), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'workforce_id', (selected.value ->> 'workforce_id')::uuid,
      'station_id', (selected.value ->> 'station_id')::uuid
    ) order by selected.position) filter (where selected.blocked), '[]'::jsonb)
  into v_rows, v_skipped_rows
  from (
    select
      chosen.value,
      chosen.position,
      public.workforce_payout_dispute_blocks_bank_row(
        p_company_id,
        (chosen.value ->> 'workforce_id')::uuid,
        (chosen.value ->> 'station_id')::uuid,
        p_period_start,
        p_period_end
      ) as blocked
    from jsonb_array_elements(p_rows) with ordinality chosen(value, position)
  ) selected;

  v_skipped_count := jsonb_array_length(v_skipped_rows);
  if v_skipped_count > 0 and jsonb_array_length(v_rows) = 0 then
    raise exception 'Every selected Workforce payout row has an open dispute. Complete or reject the disputes before creating a bank file.';
  end if;

  if v_skipped_count > 0 then
    -- The canonical ledger must describe the rows actually submitted to it. Binding that exact
    -- row set to the caller's fingerprint also makes a retry fail safely if dispute state changes.
    v_effective_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      jsonb_build_object(
        'requested_fingerprint', p_request_fingerprint,
        'effective_rows', v_rows
      )::text,
      'UTF8'
    )), 'hex');
  end if;

  v_result := public.workforce_create_payout_payment_row_batch(
    p_company_id, p_actor_user_id, p_operation_id, v_effective_fingerprint,
    p_bank_id, p_period_start, p_period_end, p_value_date, v_rows
  );

  return v_result || jsonb_build_object(
    'skipped_dispute_count', v_skipped_count,
    'skipped_dispute_rows', v_skipped_rows,
    'requested_fingerprint', p_request_fingerprint,
    'effective_request_fingerprint', v_effective_fingerprint
  );
end
$function$;

revoke all on function public.workforce_create_payout_payment_row_batch_with_disputes(
  uuid, uuid, uuid, text, uuid, date, date, date, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_create_payout_payment_row_batch_with_disputes(
  uuid, uuid, uuid, text, uuid, date, date, date, jsonb
) to service_role;

-- The normal preview and batch path excludes only the disputed station row. This trigger independently
-- protects that same row if a dispute opens after preview or an older caller bypasses preflight.
create or replace function public.guard_workforce_payout_dispute_bank_instruction()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.workforce_payout_disputes dispute
    join public.workforce_payout_publications publication on publication.id = dispute.publication_id
    left join public.workforce_payroll_runs payroll_run on payroll_run.id = publication.payroll_run_id
    where dispute.company_id = new.company_id
      and dispute.workforce_id = new.workforce_id
      and dispute.station_id = new.location_id_snapshot
      and dispute.status in (
        'open', 'in_review', 'pending_final_approval', 'approved_for_processing',
        'processing', 'processing_blocked'
      )
      and coalesce(publication.period_start, payroll_run.period_start) = new.period_start
      and coalesce(publication.period_end, payroll_run.period_end) = new.period_end
  ) then
    raise exception 'A payout dispute is still open for this Workforce ID and month. Complete or reject it before creating a bank instruction.';
  end if;
  return new;
end
$function$;

do $block$
begin
  if to_regclass('public.workforce_payout_payment_items') is not null then
    execute 'drop trigger if exists workforce_payout_payment_items_00_dispute_guard on public.workforce_payout_payment_items';
    execute 'create trigger workforce_payout_payment_items_00_dispute_guard before insert on public.workforce_payout_payment_items for each row execute function public.guard_workforce_payout_dispute_bank_instruction()';
  end if;
end
$block$;

-- Notification Settings upserts these rules when the dispute workflow is
-- enabled. Keep every v3 event code while admitting the three new payout
-- lifecycle events; older environments without the notification table remain
-- safely migratable.
do $block$
begin
  if to_regclass('public.mob_app_notification_rules') is not null then
    execute 'alter table public.mob_app_notification_rules drop constraint if exists mob_app_notification_rules_event_check';
    execute $constraint$
      alter table public.mob_app_notification_rules
        add constraint mob_app_notification_rules_event_check
        check (event_code in (
          'attendance_punch_in',
          'attendance_punch_out',
          'attendance_early_out',
          'attendance_exception_review',
          'attendance_half_day',
          'attendance_late_in',
          'attendance_overtime',
          'attendance_punch_in_reminder',
          'attendance_punch_out_reminder',
          'attendance_short_day',
          'profile_submitted',
          'profile_approved',
          'profile_returned',
          'attendance_regularization_submitted',
          'attendance_location_flagged',
          'attendance_forgot_punch_out',
          'communication_announcement',
          'leave_request_submitted',
          'advance_request_raised',
          'advance_request_approved',
          'advance_request_rejected',
          'advance_request_withdrawn',
          'exit_request_raised',
          'exit_request_approved',
          'exit_request_rejected',
          'payout_dispute_approved',
          'payout_dispute_rejected',
          'payout_dispute_resolved'
        ))
    $constraint$;
  end if;
end
$block$;

notify pgrst, 'reload schema';
commit;
