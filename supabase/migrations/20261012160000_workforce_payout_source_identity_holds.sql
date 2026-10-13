-- A report-only provider row has no Workforce UUID yet. Record its payout hold
-- against the stable provider source identity so mapping the row later cannot
-- make a previously held balance payable.
begin;

create or replace function public.workforce_payout_source_identity_key(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select pg_catalog.regexp_replace(
    pg_catalog.upper(pg_catalog.btrim(coalesce(p_value, ''))),
    '[^A-Z0-9]', '', 'g'
  )
$function$;

create or replace function public.workforce_payout_provider_identity_matches(
  p_source_identity_key text,
  p_provider_code text,
  p_provider_name text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select public.workforce_payout_source_identity_key(p_source_identity_key) <> ''
    and (
      public.workforce_payout_source_identity_key(p_source_identity_key)
        = public.workforce_payout_source_identity_key(p_provider_code)
      or public.workforce_payout_source_identity_key(p_source_identity_key)
        = public.workforce_payout_source_identity_key(p_provider_name)
      or public.workforce_payout_source_identity_key(
          coalesce(p_provider_code, '') || coalesce(p_provider_name, '')
        ) like '%' || public.workforce_payout_source_identity_key(p_source_identity_key) || '%'
      or (
        public.workforce_payout_source_identity_key(p_provider_name) <> ''
        and public.workforce_payout_source_identity_key(p_source_identity_key) like '%'
          || public.workforce_payout_source_identity_key(p_provider_name) || '%'
      )
    )
$function$;

create table public.workforce_payout_source_payment_hold_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  station_id uuid not null,
  provider_identity_key text not null,
  provider_member_id_key text not null,
  period_start date not null,
  period_end date not null,
  operation_id uuid not null,
  action text not null,
  state_changed boolean not null,
  remarks text not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_source_hold_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint workforce_payout_source_hold_operation_target_unique unique (
    company_id, operation_id, station_id, provider_identity_key, provider_member_id_key
  ),
  constraint workforce_payout_source_hold_identity_check check (
    provider_identity_key = public.workforce_payout_source_identity_key(provider_identity_key)
    and provider_identity_key <> ''
    and provider_member_id_key = public.workforce_payout_source_identity_key(provider_member_id_key)
    and provider_member_id_key <> ''
  ),
  constraint workforce_payout_source_hold_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_source_hold_action_check check (action in ('hold', 'release')),
  constraint workforce_payout_source_hold_remarks_check check (
    nullif(btrim(remarks), '') is not null and length(btrim(remarks)) between 3 and 1000
  )
);

create index workforce_payout_source_hold_latest_idx
  on public.workforce_payout_source_payment_hold_events (
    company_id, station_id, provider_identity_key, provider_member_id_key,
    period_start, period_end, created_at desc, id desc
  );
create index workforce_payout_source_hold_operation_idx
  on public.workforce_payout_source_payment_hold_events(company_id, operation_id);
create index workforce_payout_source_hold_actor_idx
  on public.workforce_payout_source_payment_hold_events(actor_user_id);

-- The public combined RPC needs its own immutable request envelope.  The two
-- child ledgers cannot prove the overall selection because a retry could omit
-- either the profile half or the source half while reusing the same operation
-- ID.  Store both canonical selections and the exact aggregate result once.
create table public.workforce_payout_combined_hold_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  action text not null,
  remarks text not null,
  selected_workforce_ids uuid[] not null,
  selected_source_identities jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_combined_hold_operations_company_operation_unique
    unique (company_id, operation_id),
  constraint workforce_payout_combined_hold_operations_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_combined_hold_operations_action_check check (
    action in ('hold', 'release')
  ),
  constraint workforce_payout_combined_hold_operations_remarks_check check (
    nullif(btrim(remarks), '') is not null and length(btrim(remarks)) between 3 and 1000
  ),
  constraint workforce_payout_combined_hold_operations_selection_check check (
    array_position(selected_workforce_ids, null) is null
    and jsonb_typeof(selected_source_identities) = 'array'
    and (
      cardinality(selected_workforce_ids) >= 1
      or jsonb_array_length(selected_source_identities) >= 1
    )
  ),
  constraint workforce_payout_combined_hold_operations_result_check check (
    jsonb_typeof(result) = 'object'
  )
);

create index workforce_payout_combined_hold_operations_actor_idx
  on public.workforce_payout_combined_hold_operations(actor_user_id, created_at desc);

alter table public.workforce_payout_source_payment_hold_events enable row level security;
alter table public.workforce_payout_source_payment_hold_events force row level security;
revoke all on table public.workforce_payout_source_payment_hold_events
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_source_payment_hold_events to service_role;
create policy workforce_payout_source_payment_hold_events_service_select
  on public.workforce_payout_source_payment_hold_events
  for select to service_role using (true);

alter table public.workforce_payout_combined_hold_operations enable row level security;
alter table public.workforce_payout_combined_hold_operations force row level security;
revoke all on table public.workforce_payout_combined_hold_operations
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_combined_hold_operations to service_role;
create policy workforce_payout_combined_hold_operations_service_select
  on public.workforce_payout_combined_hold_operations
  for select to service_role using (true);

create or replace function public.guard_workforce_payout_source_payment_hold_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_source_hold_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout source holds may be changed only by the payment lifecycle RPC.';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Workforce payout source hold history is immutable.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_source_payment_hold_events_00_append_only
before insert or update or delete on public.workforce_payout_source_payment_hold_events
for each row execute function public.guard_workforce_payout_source_payment_hold_event();

create or replace function public.guard_workforce_payout_combined_hold_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Combined Workforce payout hold operation history is immutable.';
  end if;
  if current_setting('app.workforce_payout_combined_hold_mutation', true) is distinct from 'allowed' then
    raise exception 'Combined Workforce payout hold operations may be changed only by the payment lifecycle RPC.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_combined_hold_operations_00_append_only
before insert or update or delete on public.workforce_payout_combined_hold_operations
for each row execute function public.guard_workforce_payout_combined_hold_operation();

create or replace function public.workforce_payout_source_payment_is_on_hold(
  p_company_id uuid,
  p_workforce_id uuid,
  p_station_id uuid,
  p_period_start date,
  p_period_end date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(bool_or(coalesce(latest.action = 'hold', false)), false)
  from public.field_executive_provider_mappings mapping
  join public.providers provider
    on provider.id = mapping.provider_id
   and provider.company_id = mapping.company_id
  left join lateral (
    select event.action
    from public.workforce_payout_source_payment_hold_events event
    where event.company_id = p_company_id
      and event.station_id = p_station_id
      and event.period_start = p_period_start
      and event.period_end = p_period_end
      and event.provider_member_id_key
        = public.workforce_payout_source_identity_key(mapping.provider_member_id)
      and public.workforce_payout_provider_identity_matches(
        event.provider_identity_key, provider.code, provider.name
      )
    order by event.created_at desc, event.id desc
    limit 1
  ) latest on true
  where mapping.company_id = p_company_id
    and mapping.station_id = p_station_id
    and mapping.status in ('active', 'closed')
    and mapping.effective_from <= p_period_end
    and coalesce(mapping.effective_to, p_period_end) >= p_period_start
    and public.workforce_provider_mapping_person(
      mapping.company_id,
      mapping.workforce_id,
      mapping.field_executive_id,
      mapping.employee_id,
      mapping.contractor_id
    ) = p_workforce_id
$function$;

create or replace function public.workforce_set_payout_source_payment_holds(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_sources jsonb,
  p_period_start date,
  p_period_end date,
  p_hold boolean,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sources jsonb;
  v_action text := case when p_hold then 'hold' else 'release' end;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_existing_count integer := 0;
  v_existing_changed integer := 0;
  v_existing_sources jsonb;
  v_existing_matches boolean := false;
  v_locked_count integer := 0;
  v_changed integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_hold is null
  then
    raise exception 'Company, actor, operation and hold state are required.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Payment holds require one exact calendar month.';
  end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment hold remark between 3 and 1000 characters.';
  end if;
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) < 1 then
    raise exception 'Select at least one provider payout source.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_sources) submitted(value)
    where jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or public.workforce_payout_source_identity_key(submitted.value ->> 'provider_identity') = ''
      or public.workforce_payout_source_identity_key(submitted.value ->> 'provider_member_id') = ''
  ) then
    raise exception 'Every provider payout source requires a valid station, provider and provider member ID.';
  end if;

  select jsonb_agg(jsonb_build_object(
      'station_id', normalized.station_id,
      'provider_identity_key', normalized.provider_identity_key,
      'provider_member_id_key', normalized.provider_member_id_key
    ) order by normalized.station_id, normalized.provider_identity_key, normalized.provider_member_id_key)
  into v_sources
  from (
    select distinct
      (submitted.value ->> 'station_id')::uuid as station_id,
      public.workforce_payout_source_identity_key(
        submitted.value ->> 'provider_identity'
      ) as provider_identity_key,
      public.workforce_payout_source_identity_key(
        submitted.value ->> 'provider_member_id'
      ) as provider_member_id_key
    from jsonb_array_elements(p_sources) submitted(value)
  ) normalized;

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select
    count(*)::integer,
    count(*) > 0 and bool_and(
      event.period_start = p_period_start
      and event.period_end = p_period_end
      and event.action = v_action
      and event.remarks = v_remarks
      and event.actor_user_id = p_actor_user_id
    ),
    coalesce(sum(case when event.state_changed then 1 else 0 end), 0)::integer,
    jsonb_agg(jsonb_build_object(
      'station_id', event.station_id,
      'provider_identity_key', event.provider_identity_key,
      'provider_member_id_key', event.provider_member_id_key
    ) order by event.station_id, event.provider_identity_key, event.provider_member_id_key)
  into v_existing_count, v_existing_matches, v_existing_changed, v_existing_sources
  from public.workforce_payout_source_payment_hold_events event
  where event.company_id = p_company_id
    and event.operation_id = p_operation_id;
  if v_existing_count > 0 then
    if not v_existing_matches or v_existing_sources is distinct from v_sources then
      raise exception 'This provider payout hold operation ID was already used for a different request.';
    end if;
    return jsonb_build_object(
      'changed', v_existing_changed,
      'processed', v_existing_count,
      'on_hold', p_hold,
      'replayed', true
    );
  end if;

  -- Use the same company-wide serialization point as bank generation before
  -- taking source rows. This ordering also keeps combined profile+source hold
  -- requests deadlock-free.
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  perform station.id
  from public.stations station
  join jsonb_array_elements(v_sources) selected(value)
    on station.id = (selected.value ->> 'station_id')::uuid
  where station.company_id = p_company_id
  order by station.id
  for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> jsonb_array_length(v_sources) then
    raise exception 'One or more selected provider payout stations are unavailable in this company.';
  end if;
  -- Recheck after the canonical company lock so concurrent retries return the
  -- original result and bank generation cannot race a new source hold.
  select
    count(*)::integer,
    count(*) > 0 and bool_and(
      event.period_start = p_period_start
      and event.period_end = p_period_end
      and event.action = v_action
      and event.remarks = v_remarks
      and event.actor_user_id = p_actor_user_id
    ),
    coalesce(sum(case when event.state_changed then 1 else 0 end), 0)::integer,
    jsonb_agg(jsonb_build_object(
      'station_id', event.station_id,
      'provider_identity_key', event.provider_identity_key,
      'provider_member_id_key', event.provider_member_id_key
    ) order by event.station_id, event.provider_identity_key, event.provider_member_id_key)
  into v_existing_count, v_existing_matches, v_existing_changed, v_existing_sources
  from public.workforce_payout_source_payment_hold_events event
  where event.company_id = p_company_id
    and event.operation_id = p_operation_id;
  if v_existing_count > 0 then
    if not v_existing_matches or v_existing_sources is distinct from v_sources then
      raise exception 'This provider payout hold operation ID was already used for a different request.';
    end if;
    return jsonb_build_object(
      'changed', v_existing_changed,
      'processed', v_existing_count,
      'on_hold', p_hold,
      'replayed', true
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_sources) selected(value)
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = p_company_id
     and mapping.station_id = (selected.value ->> 'station_id')::uuid
     and public.workforce_payout_source_identity_key(mapping.provider_member_id)
       = selected.value ->> 'provider_member_id_key'
     and mapping.status in ('active', 'closed')
     and mapping.effective_from <= p_period_end
     and coalesce(mapping.effective_to, p_period_end) >= p_period_start
    join public.providers provider
      on provider.company_id = mapping.company_id
     and provider.id = mapping.provider_id
     and public.workforce_payout_provider_identity_matches(
       selected.value ->> 'provider_identity_key', provider.code, provider.name
     )
    join public.workforce_payout_payment_items item
      on item.company_id = p_company_id
     and item.workforce_id = public.workforce_provider_mapping_person(
       mapping.company_id,
       mapping.workforce_id,
       mapping.field_executive_id,
       mapping.employee_id,
       mapping.contractor_id
     )
     and item.period_start = p_period_start
     and item.period_end = p_period_end
     and item.status = 'processing'
  ) then
    raise exception 'One or more selected provider payouts are Payment Processing. Cancel or finalize processing before changing the hold.';
  end if;

  perform set_config('app.workforce_payout_source_hold_mutation', 'allowed', true);
  with selected as (
    select
      (source.value ->> 'station_id')::uuid as station_id,
      source.value ->> 'provider_identity_key' as provider_identity_key,
      source.value ->> 'provider_member_id_key' as provider_member_id_key
    from jsonb_array_elements(v_sources) source(value)
  ), states as (
    select selected.*,
      coalesce(current.action = 'hold', false) as is_held
    from selected
    left join lateral (
      select event.action
      from public.workforce_payout_source_payment_hold_events event
      where event.company_id = p_company_id
        and event.station_id = selected.station_id
        and event.provider_member_id_key = selected.provider_member_id_key
        and event.period_start = p_period_start
        and event.period_end = p_period_end
        and (
          event.provider_identity_key = selected.provider_identity_key
          or exists (
            select 1
            from public.field_executive_provider_mappings mapping
            join public.providers provider
              on provider.company_id = mapping.company_id
             and provider.id = mapping.provider_id
            where mapping.company_id = p_company_id
              and mapping.station_id = selected.station_id
              and public.workforce_payout_source_identity_key(mapping.provider_member_id)
                = selected.provider_member_id_key
              and mapping.status in ('active', 'closed')
              and mapping.effective_from <= p_period_end
              and coalesce(mapping.effective_to, p_period_end) >= p_period_start
              and public.workforce_payout_provider_identity_matches(
                selected.provider_identity_key, provider.code, provider.name
              )
              and public.workforce_payout_provider_identity_matches(
                event.provider_identity_key, provider.code, provider.name
              )
          )
        )
      order by event.created_at desc, event.id desc
      limit 1
    ) current on true
  ), inserted as (
    insert into public.workforce_payout_source_payment_hold_events (
      company_id, station_id, provider_identity_key, provider_member_id_key,
      period_start, period_end, operation_id, action, state_changed,
      remarks, actor_user_id
    )
    select
      p_company_id, state.station_id, state.provider_identity_key,
      state.provider_member_id_key, p_period_start, p_period_end,
      p_operation_id, v_action, state.is_held is distinct from p_hold,
      v_remarks, p_actor_user_id
    from states state
    returning state_changed
  )
  select coalesce(sum(case when inserted.state_changed then 1 else 0 end), 0)::integer
  into v_changed
  from inserted;

  return jsonb_build_object(
    'changed', v_changed,
    'processed', jsonb_array_length(v_sources),
    'on_hold', p_hold,
    'replayed', false
  );
end
$function$;

create or replace function public.workforce_set_payout_combined_payment_holds(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_workforce_ids uuid[],
  p_sources jsonb,
  p_period_start date,
  p_period_end date,
  p_hold boolean,
  p_remarks text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_combined_hold_operations%rowtype;
  v_submitted_workforce_ids uuid[] := coalesce(p_workforce_ids, '{}'::uuid[]);
  v_submitted_sources jsonb := coalesce(p_sources, '[]'::jsonb);
  v_workforce_ids uuid[] := '{}'::uuid[];
  v_source_identities jsonb := '[]'::jsonb;
  v_sources_for_child jsonb := '[]'::jsonb;
  v_station_ids uuid[] := '{}'::uuid[];
  v_action text := case when p_hold then 'hold' else 'release' end;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_profile_result jsonb := '{}'::jsonb;
  v_source_result jsonb := '{}'::jsonb;
  v_profile_count integer := 0;
  v_source_count integer := 0;
  v_profile_changed integer := 0;
  v_source_changed integer := 0;
  v_locked_count integer := 0;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_hold is null
  then
    raise exception 'Company, actor, operation and hold state are required.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Payment holds require one exact calendar month.';
  end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment hold remark between 3 and 1000 characters.';
  end if;
  if jsonb_typeof(v_submitted_sources) <> 'array' then
    raise exception 'Provider payout sources must be submitted as an array.';
  end if;
  if array_position(v_submitted_workforce_ids, null) is not null then
    raise exception 'Every selected Workforce payout requires a valid Workforce profile.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_submitted_sources) submitted(value)
    where jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or public.workforce_payout_source_identity_key(submitted.value ->> 'provider_identity') = ''
      or public.workforce_payout_source_identity_key(submitted.value ->> 'provider_member_id') = ''
  ) then
    raise exception 'Every provider payout source requires a valid station, provider and provider member ID.';
  end if;

  select coalesce(
    array_agg(distinct selected.workforce_id order by selected.workforce_id),
    '{}'::uuid[]
  )
  into v_workforce_ids
  from unnest(v_submitted_workforce_ids) selected(workforce_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'station_id', normalized.station_id,
      'provider_identity_key', normalized.provider_identity_key,
      'provider_member_id_key', normalized.provider_member_id_key
    ) order by normalized.station_id, normalized.provider_identity_key,
      normalized.provider_member_id_key), '[]'::jsonb)
  into v_source_identities
  from (
    select distinct
      (submitted.value ->> 'station_id')::uuid as station_id,
      public.workforce_payout_source_identity_key(
        submitted.value ->> 'provider_identity'
      ) as provider_identity_key,
      public.workforce_payout_source_identity_key(
        submitted.value ->> 'provider_member_id'
      ) as provider_member_id_key
    from jsonb_array_elements(v_submitted_sources) submitted(value)
  ) normalized;

  select coalesce(jsonb_agg(jsonb_build_object(
      'station_id', canonical.value ->> 'station_id',
      'provider_identity', canonical.value ->> 'provider_identity_key',
      'provider_member_id', canonical.value ->> 'provider_member_id_key'
    ) order by canonical.value ->> 'station_id',
      canonical.value ->> 'provider_identity_key',
      canonical.value ->> 'provider_member_id_key'), '[]'::jsonb)
  into v_sources_for_child
  from jsonb_array_elements(v_source_identities) canonical(value);

  select coalesce(array_agg(distinct (canonical.value ->> 'station_id')::uuid
    order by (canonical.value ->> 'station_id')::uuid), '{}'::uuid[])
  into v_station_ids
  from jsonb_array_elements(v_source_identities) canonical(value);

  if cardinality(v_workforce_ids) < 1
    and jsonb_array_length(v_source_identities) < 1
  then
    raise exception 'Select at least one Workforce profile or provider payout source.';
  end if;

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  -- Fast replay is permitted only for the exact canonical overall envelope.
  -- In particular, one operation cannot be retried as profile-only or
  -- source-only after its original profile+source command.
  select operation.* into v_existing
  from public.workforce_payout_combined_hold_operations operation
  where operation.company_id = p_company_id
    and operation.operation_id = p_operation_id;
  if found then
    if v_existing.actor_user_id <> p_actor_user_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.selected_workforce_ids <> v_workforce_ids
      or v_existing.selected_source_identities <> v_source_identities
    then
      raise exception 'This combined payment hold operation ID was already used for a different request.';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  -- Never expand a prior child-only command into a new combined envelope.
  if exists (
    select 1
    from public.workforce_payout_payment_hold_operations operation
    where operation.company_id = p_company_id
      and operation.operation_id = p_operation_id
  ) or exists (
    select 1
    from public.workforce_payout_source_payment_hold_events event
    where event.company_id = p_company_id
      and event.operation_id = p_operation_id
  ) then
    raise exception 'This combined payment hold operation ID was already used for a different request.';
  end if;

  -- Canonical lock order matches the bank and child hold lifecycles: profiles,
  -- company allocation, then distinct stations.  Recheck the immutable
  -- envelope after these locks to close simultaneous retry races.
  if cardinality(v_workforce_ids) > 0 then
    perform workforce.id
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = any(v_workforce_ids)
    order by workforce.id
    for update;
    get diagnostics v_locked_count = row_count;
    if v_locked_count <> cardinality(v_workforce_ids) then
      raise exception 'One or more selected Workforce profiles are unavailable in this company.';
    end if;
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  if cardinality(v_station_ids) > 0 then
    perform station.id
    from public.stations station
    where station.company_id = p_company_id
      and station.id = any(v_station_ids)
    order by station.id
    for update;
    get diagnostics v_locked_count = row_count;
    if v_locked_count <> cardinality(v_station_ids) then
      raise exception 'One or more selected provider payout stations are unavailable in this company.';
    end if;
  end if;

  select operation.* into v_existing
  from public.workforce_payout_combined_hold_operations operation
  where operation.company_id = p_company_id
    and operation.operation_id = p_operation_id;
  if found then
    if v_existing.actor_user_id <> p_actor_user_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks
      or v_existing.selected_workforce_ids <> v_workforce_ids
      or v_existing.selected_source_identities <> v_source_identities
    then
      raise exception 'This combined payment hold operation ID was already used for a different request.';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  if exists (
    select 1
    from public.workforce_payout_payment_hold_operations operation
    where operation.company_id = p_company_id
      and operation.operation_id = p_operation_id
  ) or exists (
    select 1
    from public.workforce_payout_source_payment_hold_events event
    where event.company_id = p_company_id
      and event.operation_id = p_operation_id
  ) then
    raise exception 'This combined payment hold operation ID was already used for a different request.';
  end if;

  if cardinality(v_workforce_ids) > 0 then
    v_profile_result := public.workforce_set_payout_payment_holds(
      p_company_id,
      p_actor_user_id,
      p_operation_id,
      v_workforce_ids,
      p_period_start,
      p_period_end,
      p_hold,
      p_remarks
    );
    v_profile_count := coalesce((v_profile_result ->> 'selected_count')::integer, 0);
    v_profile_changed := coalesce((v_profile_result ->> 'changed_count')::integer, 0);
  end if;

  if jsonb_array_length(v_source_identities) > 0 then
    v_source_result := public.workforce_set_payout_source_payment_holds(
      p_company_id,
      p_actor_user_id,
      p_operation_id,
      v_sources_for_child,
      p_period_start,
      p_period_end,
      p_hold,
      p_remarks
    );
    v_source_count := coalesce((v_source_result ->> 'processed')::integer, 0);
    v_source_changed := coalesce((v_source_result ->> 'changed')::integer, 0);
  end if;

  v_result := jsonb_build_object(
    'changed', v_profile_changed + v_source_changed,
    'processed', v_profile_count + v_source_count,
    'on_hold', p_hold,
    'replayed', false,
    'profile_result', v_profile_result,
    'source_result', v_source_result
  );

  perform set_config('app.workforce_payout_combined_hold_mutation', 'allowed', true);
  insert into public.workforce_payout_combined_hold_operations (
    company_id, operation_id, actor_user_id, period_start, period_end,
    action, remarks, selected_workforce_ids, selected_source_identities, result
  ) values (
    p_company_id, p_operation_id, p_actor_user_id, p_period_start, p_period_end,
    v_action, v_remarks, v_workforce_ids, v_source_identities, v_result
  );

  return v_result;
end
$function$;

-- Extend the authoritative preview used by both the worksheet and bank-file
-- creator. A source hold therefore remains effective after the identity is
-- mapped and after later payout inputs create a positive balance.
do $patch$
declare
  v_definition text;
  v_marker text := $marker$
    if available_to_pay <= 0 then
$marker$;
  v_replacement text := $replacement$
    if public.workforce_payout_source_payment_is_on_hold(
      p_company_id, v_workforce_id, v_station_id, p_period_start, p_period_end
    ) then
      available_to_pay := 0;
      payment_status := 'On Hold';
      eligibility_code := 'payment_on_hold';
      eligibility_message := format(
        'Payment is on hold for Workforce ID %s.', coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if available_to_pay <= 0 then
$replacement$;
begin
  select replace(pg_get_functiondef(
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ), chr(13), '')
  into v_definition;
  v_marker := replace(v_marker, chr(13), '');
  v_replacement := replace(v_replacement, chr(13), '');
  if position('workforce_payout_source_payment_is_on_hold' in v_definition) = 0 then
    if position(v_marker in v_definition) = 0 then
      raise exception 'Unexpected Workforce row candidate structure; source-hold gate was not installed.';
    end if;
    execute replace(v_definition, v_marker, v_replacement);
  end if;
end
$patch$;

-- The batch creator and hold RPC share the company allocation lock. This
-- trigger is an additional fail-closed invariant for any future insert path.
create or replace function public.guard_workforce_payout_payment_source_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if public.workforce_payout_source_payment_is_on_hold(
    new.company_id,
    new.workforce_id,
    new.location_id_snapshot,
    new.period_start,
    new.period_end
  ) then
    raise exception 'This Workforce payout source is On Hold and cannot be included in a bank file.';
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_payment_items_05_source_hold_guard
  on public.workforce_payout_payment_items;
create trigger workforce_payout_payment_items_05_source_hold_guard
before insert on public.workforce_payout_payment_items
for each row execute function public.guard_workforce_payout_payment_source_hold();

comment on table public.workforce_payout_source_payment_hold_events is
  'Append-only payout hold commands keyed by provider source identity, including report-only rows that have no Workforce UUID yet.';
comment on table public.workforce_payout_combined_hold_operations is
  'Immutable exact request envelopes for combined profile and provider-source payout Hold or Unhold commands.';
comment on function public.workforce_set_payout_source_payment_holds(
  uuid, uuid, uuid, jsonb, date, date, boolean, text
) is
  'Atomically holds or releases provider source identities for one payout month, with exact idempotent replay and processing-payment rejection.';
comment on function public.workforce_set_payout_combined_payment_holds(
  uuid, uuid, uuid, uuid[], jsonb, date, date, boolean, text
) is
  'Atomically applies one audited Hold or Unhold command to mapped Workforce profiles and durable provider source identities.';
comment on function public.workforce_payout_source_payment_is_on_hold(
  uuid, uuid, uuid, date, date
) is
  'Resolves current provider mappings to durable source-identity holds for bank preview and generation.';

revoke all on function public.workforce_payout_source_identity_key(text)
  from public, anon, authenticated;
revoke all on function public.workforce_payout_provider_identity_matches(text, text, text)
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_source_payment_hold_event()
  from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_combined_hold_operation()
  from public, anon, authenticated;
revoke all on function public.workforce_payout_source_payment_is_on_hold(
  uuid, uuid, uuid, date, date
) from public, anon, authenticated;
revoke all on function public.workforce_set_payout_source_payment_holds(
  uuid, uuid, uuid, jsonb, date, date, boolean, text
) from public, anon, authenticated;
revoke all on function public.workforce_set_payout_combined_payment_holds(
  uuid, uuid, uuid, uuid[], jsonb, date, date, boolean, text
) from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_payment_source_hold()
  from public, anon, authenticated;

grant execute on function public.workforce_payout_source_payment_is_on_hold(
  uuid, uuid, uuid, date, date
) to service_role;
grant execute on function public.workforce_set_payout_source_payment_holds(
  uuid, uuid, uuid, jsonb, date, date, boolean, text
) to service_role;
grant execute on function public.workforce_set_payout_combined_payment_holds(
  uuid, uuid, uuid, uuid[], jsonb, date, date, boolean, text
) to service_role;

commit;

notify pgrst, 'reload schema';
