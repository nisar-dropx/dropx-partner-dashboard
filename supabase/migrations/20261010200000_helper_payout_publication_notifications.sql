begin;

create unique index if not exists helpers_company_id_id_uidx
  on public.helpers (company_id, id);
create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);

-- Helper payout calculation combines the existing company/month dependency
-- revisions with a Helper-wide sequence for Helper-only inputs. The
-- company/month revision system already covers attendance, payment settings,
-- payment components, deduction/addition masters and stations. Helpers and
-- biometric enrolments are added below because they were not part of the
-- original Workforce dependency list.
create table public.helper_payout_dependency_changes (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  helper_id uuid not null,
  station_id uuid not null,
  effective_from date not null,
  effective_to date,
  source_table text not null,
  source_row_id uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint helper_payout_dependency_changes_helper_company_fk
    foreign key (company_id, helper_id)
    references public.helpers(company_id, id) on delete restrict,
  constraint helper_payout_dependency_changes_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id) on delete restrict,
  constraint helper_payout_dependency_changes_period_check
    check (effective_to is null or effective_to >= effective_from),
  constraint helper_payout_dependency_changes_source_check check (
    source_table in (
      'helper_payment_allocations',
      'helper_payout_attendance_values',
      'helper_additional_payment_values',
      'helper_payout_deduction_values'
    )
  )
);

create index helper_payout_dependency_changes_lookup_idx
  on public.helper_payout_dependency_changes(
    company_id, helper_id, effective_from, effective_to, id desc
  );

create table if not exists public.helper_payout_publications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  helper_id uuid not null,
  station_id uuid not null,
  revision integer not null,
  snapshot jsonb not null,
  snapshot_hash text not null,
  review_submission_id uuid not null references public.workforce_payout_review_submissions(id) on delete restrict,
  published_by uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz not null default now(),
  review_until timestamptz not null,
  notify_at timestamptz not null,
  notification_status text not null default 'pending',
  notification_error text,
  notification_reference text,
  notification_attempted_at timestamptz,
  notification_config_snapshot jsonb not null,
  period_start date not null,
  period_end date not null,
  payout_source_change_id bigint not null default 0,
  payout_dependency_hash text not null default repeat('0', 32),
  constraint helper_payout_publications_helper_company_fk
    foreign key (company_id, helper_id)
    references public.helpers(company_id, id)
    on delete restrict,
  constraint helper_payout_publications_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint helper_payout_publications_revision_check check (revision > 0),
  constraint helper_payout_publications_period_check check (
    period_start = date_trunc('month', period_start)::date
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint helper_payout_publications_snapshot_check check (
    jsonb_typeof(snapshot) = 'object'
    and snapshot ->> 'schema_version' = '2'
    and snapshot ->> 'source' = 'helper_payout_worksheet'
    and snapshot #>> '{item,helper_id}' = helper_id::text
    and snapshot #>> '{item,station_id}' = station_id::text
    and snapshot #>> '{run,period_start}' = period_start::text
    and snapshot #>> '{run,period_end}' = period_end::text
    and nullif(btrim(snapshot_hash), '') is not null
  ),
  constraint helper_payout_publications_notification_snapshot_check check (
    jsonb_typeof(notification_config_snapshot) = 'object'
    and notification_config_snapshot ->> 'schema_version' = '1'
    and notification_config_snapshot ->> 'event_code' = 'workforce_payout_review'
  ),
  constraint helper_payout_publications_notification_status_check check (
    notification_status in (
      'pending', 'sending', 'sent', 'failed', 'uncertain', 'superseded', 'disabled'
    )
  ),
  constraint helper_payout_publications_source_change_check
    check (payout_source_change_id >= 0),
  constraint helper_payout_publications_dependency_hash_check
    check (payout_dependency_hash ~ '^[0-9a-f]{32}$'),
  constraint helper_payout_publications_identity_revision_unique unique (
    company_id, helper_id, station_id, period_start, period_end, revision
  )
);

create index if not exists helper_payout_publications_period_idx
  on public.helper_payout_publications (
    company_id, helper_id, period_start, period_end, published_at desc
  );
create unique index if not exists helper_payout_publications_company_id_id_uidx
  on public.helper_payout_publications (company_id, id);
create index if not exists helper_payout_publications_review_idx
  on public.helper_payout_publications (review_submission_id);
create index if not exists helper_payout_publications_notification_queue_idx
  on public.helper_payout_publications (notify_at, id)
  where notification_status = 'pending';

comment on table public.helper_payout_publications is
  'Immutable monthly Helper payout snapshots. Delivery state is mutable, while identity, amounts, recipient configuration and publication audit are frozen.';

alter table public.helper_payout_publications enable row level security;
alter table public.helper_payout_publications force row level security;
revoke all on table public.helper_payout_publications
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.helper_payout_publications
  to service_role;

alter table public.helper_payout_dependency_changes enable row level security;
alter table public.helper_payout_dependency_changes force row level security;
revoke all on table public.helper_payout_dependency_changes
  from public, anon, authenticated, service_role;
grant select on table public.helper_payout_dependency_changes to service_role;
create policy helper_payout_dependency_changes_service_select
  on public.helper_payout_dependency_changes
  for select to service_role using (true);

create or replace function public.helper_payout_shared_dependency_hash(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  with requested_months as (
    select month_value::date as period_month
    from generate_series(
      date_trunc('month', p_period_start)::date,
      date_trunc('month', p_period_end)::date,
      interval '1 month'
    ) month_value
  ), period_material as (
    select coalesce(string_agg(
      requested.period_month::text || '=' || coalesce(revision.revision, 0)::text,
      ',' order by requested.period_month
    ), '') as value
    from requested_months requested
    left join public.workforce_payout_period_dependency_revisions revision
      on revision.company_id = p_company_id
     and revision.period_month = requested.period_month
  )
  select md5(
    p_company_id::text || ':' ||
    p_period_start::text || ':' ||
    p_period_end::text || ':' ||
    least(
      p_period_end,
      (statement_timestamp() at time zone 'Asia/Kolkata')::date
    )::text || ':' ||
    coalesce(company_revision.revision, 0)::text || ':' ||
    period_material.value
  )
  from period_material
  left join public.workforce_payout_dependency_revisions company_revision
    on company_revision.company_id = p_company_id;
$function$;

create or replace function public.guard_helper_payout_dependency_change_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'Helper payout dependency changes are immutable.';
end
$function$;

create or replace function public.record_helper_payout_dependency_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old_active boolean := false;
  v_new_active boolean := false;
  v_old_identity text;
  v_new_identity text;
  v_audit_keys text[] := array[
    'created_at','created_by','updated_at','updated_by',
    'source_batch_id','source_row_id','change_reason'
  ];
begin
  if tg_op = 'UPDATE' and (v_new - v_audit_keys) is not distinct from (v_old - v_audit_keys) then
    return null;
  end if;

  v_old_active := v_old is not null
    and (tg_table_name <> 'helper_payment_allocations'
      or coalesce(v_old ->> 'status', '') <> 'cancelled');
  v_new_active := v_new is not null
    and (tg_table_name <> 'helper_payment_allocations'
      or coalesce(v_new ->> 'status', '') <> 'cancelled');

  -- Source writers and publishers take the same Helper row lock, so the
  -- effective-dated sequence can be compared transactionally.
  perform 1
  from public.helpers helper
  where (v_old_active and helper.company_id = (v_old ->> 'company_id')::uuid
      and helper.id = (v_old ->> 'helper_id')::uuid)
    or (v_new_active and helper.company_id = (v_new ->> 'company_id')::uuid
      and helper.id = (v_new ->> 'helper_id')::uuid)
  order by helper.id
  for update;

  if v_old_active then
    v_old_identity := concat_ws('|',
      v_old ->> 'company_id', v_old ->> 'helper_id', v_old ->> 'station_id',
      v_old ->> 'effective_from', coalesce(v_old ->> 'effective_to', 'infinity')
    );
    insert into public.helper_payout_dependency_changes(
      company_id, helper_id, station_id, effective_from, effective_to,
      source_table, source_row_id
    ) values (
      (v_old ->> 'company_id')::uuid, (v_old ->> 'helper_id')::uuid,
      (v_old ->> 'station_id')::uuid, (v_old ->> 'effective_from')::date,
      nullif(v_old ->> 'effective_to', '')::date,
      tg_table_name, (v_old ->> 'id')::uuid
    );
  end if;

  if v_new_active then
    v_new_identity := concat_ws('|',
      v_new ->> 'company_id', v_new ->> 'helper_id', v_new ->> 'station_id',
      v_new ->> 'effective_from', coalesce(v_new ->> 'effective_to', 'infinity')
    );
    if not v_old_active or v_new_identity is distinct from v_old_identity then
      insert into public.helper_payout_dependency_changes(
        company_id, helper_id, station_id, effective_from, effective_to,
        source_table, source_row_id
      ) values (
        (v_new ->> 'company_id')::uuid, (v_new ->> 'helper_id')::uuid,
        (v_new ->> 'station_id')::uuid, (v_new ->> 'effective_from')::date,
        nullif(v_new ->> 'effective_to', '')::date,
        tg_table_name, (v_new ->> 'id')::uuid
      );
    end if;
  end if;
  return null;
end
$function$;

create or replace function public.stamp_helper_payout_publication_dependencies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform 1
  from public.helpers helper
  where helper.company_id = new.company_id and helper.id = new.helper_id
  for update;
  if not found then
    raise exception 'Helper profile was not found for payout publication.';
  end if;

  perform public.lock_workforce_payment_allocation_company(new.company_id);
  new.payout_dependency_hash := public.helper_payout_shared_dependency_hash(
    new.company_id, new.period_start, new.period_end
  );
  select coalesce(max(change.id), 0)
  into new.payout_source_change_id
  from public.helper_payout_dependency_changes change
  where change.company_id = new.company_id
    and change.helper_id = new.helper_id
    and daterange(change.effective_from, coalesce(change.effective_to, 'infinity'::date), '[]')
      && daterange(new.period_start, new.period_end, '[]');
  return new;
end
$function$;

create or replace function public.helper_payout_dependency_state(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns table (
  helper_id uuid,
  station_id uuid,
  payout_source_change_id bigint,
  payout_dependency_hash text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_hash text;
begin
  if p_company_id is null
    or p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'A company and exact calendar month are required for Helper payout dependency state.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'At least one Helper payout identity is required.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) selected(value)
    where coalesce(selected.value ->> 'helper_id', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(selected.value ->> 'station_id', '') !~* '^[0-9a-f-]{36}$'
  ) then
    raise exception 'Every Helper payout dependency row requires a valid Helper and station.';
  end if;

  v_hash := public.helper_payout_shared_dependency_hash(
    p_company_id, p_period_start, p_period_end
  );
  return query
  select selected.helper_id, selected.station_id,
    coalesce(max(change.id), 0) as payout_source_change_id,
    v_hash as payout_dependency_hash
  from (
    select distinct
      (item.value ->> 'helper_id')::uuid as helper_id,
      (item.value ->> 'station_id')::uuid as station_id
    from jsonb_array_elements(p_rows) item(value)
  ) selected
  left join public.helper_payout_dependency_changes change
    on change.company_id = p_company_id
   and change.helper_id = selected.helper_id
   and daterange(change.effective_from, coalesce(change.effective_to, 'infinity'::date), '[]')
     && daterange(p_period_start, p_period_end, '[]')
  group by selected.helper_id, selected.station_id
  order by selected.helper_id, selected.station_id;
end
$function$;

create trigger helper_payout_dependency_changes_00_immutable
before update or delete on public.helper_payout_dependency_changes
for each row execute function public.guard_helper_payout_dependency_change_immutable();
create trigger helper_payout_dependency_changes_00_no_truncate
before truncate on public.helper_payout_dependency_changes
for each statement execute function public.guard_helper_payout_dependency_change_immutable();
create trigger helper_payment_allocations_80_dependency_change
after insert or update or delete on public.helper_payment_allocations
for each row execute function public.record_helper_payout_dependency_change();
create trigger helper_payout_attendance_values_80_dependency_change
after insert or update or delete on public.helper_payout_attendance_values
for each row execute function public.record_helper_payout_dependency_change();
create trigger helper_additional_payment_values_80_dependency_change
after insert or update or delete on public.helper_additional_payment_values
for each row execute function public.record_helper_payout_dependency_change();
create trigger helper_payout_deduction_values_80_dependency_change
after insert or update or delete on public.helper_payout_deduction_values
for each row execute function public.record_helper_payout_dependency_change();
create trigger helper_payment_allocations_80_dependency_truncate
after truncate on public.helper_payment_allocations
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();
create trigger helper_payout_attendance_values_80_dependency_truncate
after truncate on public.helper_payout_attendance_values
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();
create trigger helper_additional_payment_values_80_dependency_truncate
after truncate on public.helper_additional_payment_values
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();
create trigger helper_payout_deduction_values_80_dependency_truncate
after truncate on public.helper_payout_deduction_values
for each statement execute function public.workforce_touch_all_payout_dependency_revisions();
create trigger helper_payout_publications_00_dependencies
before insert on public.helper_payout_publications
for each row execute function public.stamp_helper_payout_publication_dependencies();

do $block$
declare
  v_table text;
begin
  foreach v_table in array array['helpers', 'biometric_enrolments']
  loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'Required Helper payout dependency table public.% is missing.', v_table;
    end if;
    execute format('drop trigger if exists helper_payout_dependency_revision_insert on public.%I', v_table);
    execute format(
      'create trigger helper_payout_dependency_revision_insert after insert on public.%I '
      || 'referencing new table as payout_dependency_new_rows for each statement '
      || 'execute function public.workforce_touch_payout_dependency_from_new_rows()',
      v_table
    );
    execute format('drop trigger if exists helper_payout_dependency_revision_update on public.%I', v_table);
    execute format(
      'create trigger helper_payout_dependency_revision_update after update on public.%I '
      || 'referencing old table as payout_dependency_old_rows new table as payout_dependency_new_rows '
      || 'for each statement execute function public.workforce_touch_payout_dependency_from_changed_rows()',
      v_table
    );
    execute format('drop trigger if exists helper_payout_dependency_revision_delete on public.%I', v_table);
    execute format(
      'create trigger helper_payout_dependency_revision_delete after delete on public.%I '
      || 'referencing old table as payout_dependency_old_rows for each statement '
      || 'execute function public.workforce_touch_payout_dependency_from_old_rows()',
      v_table
    );
    execute format('drop trigger if exists helper_payout_dependency_revision_truncate on public.%I', v_table);
    execute format(
      'create trigger helper_payout_dependency_revision_truncate after truncate on public.%I '
      || 'for each statement execute function public.workforce_touch_all_payout_dependency_revisions()',
      v_table
    );
  end loop;
end
$block$;

create or replace function public.guard_helper_payout_publication_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'A Helper payout publication cannot be deleted.';
  end if;
  if row(
    new.company_id, new.helper_id, new.station_id, new.revision,
    new.snapshot, new.snapshot_hash, new.review_submission_id,
    new.published_by, new.published_at, new.review_until, new.notify_at,
    new.notification_config_snapshot, new.period_start, new.period_end,
    new.payout_source_change_id, new.payout_dependency_hash
  ) is distinct from row(
    old.company_id, old.helper_id, old.station_id, old.revision,
    old.snapshot, old.snapshot_hash, old.review_submission_id,
    old.published_by, old.published_at, old.review_until, old.notify_at,
    old.notification_config_snapshot, old.period_start, old.period_end,
    old.payout_source_change_id, old.payout_dependency_hash
  ) then
    raise exception 'A published Helper payout snapshot is immutable.';
  end if;
  return new;
end
$function$;

drop trigger if exists helper_payout_publications_00_immutable
  on public.helper_payout_publications;
create trigger helper_payout_publications_00_immutable
before update or delete on public.helper_payout_publications
for each row execute function public.guard_helper_payout_publication_immutable();

create or replace function public.helper_claim_payout_review_notification(
  p_publication_id uuid,
  p_attempted_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_publication public.helper_payout_publications%rowtype;
begin
  if p_publication_id is null or p_attempted_at is null then
    return null;
  end if;

  select publication.*
  into v_publication
  from public.helper_payout_publications publication
  where publication.id = p_publication_id;
  if not found then return null; end if;

  perform 1
  from public.helpers helper
  where helper.company_id = v_publication.company_id
    and helper.id = v_publication.helper_id
  for update;

  select publication.*
  into v_publication
  from public.helper_payout_publications publication
  where publication.id = p_publication_id
  for update;
  if not found
    or v_publication.notification_status <> 'pending'
    or v_publication.notify_at > p_attempted_at
  then
    return null;
  end if;

  update public.helper_payout_publications publication
  set notification_status = 'sending',
      notification_attempted_at = p_attempted_at
  where publication.id = v_publication.id;
  return v_publication.id;
end
$function$;

create or replace function public.helper_publish_payout_notifications(
  p_company uuid,
  p_actor uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_locations uuid[] default null,
  p_review_until timestamptz default null,
  p_notify_at timestamptz default now(),
  p_notification_config_id uuid default null,
  p_notification_config_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item jsonb;
  item_subject uuid;
  item_location uuid;
  item_expected_status text;
  item_snapshot jsonb;
  item_snapshot_hash text;
  item_notification_snapshot jsonb;
  item_notification_primary boolean;
  item_expected_source_change_id bigint;
  item_expected_dependency_hash text;
  existing_review_status text;
  helper_has_snapshot_change boolean;
  review_next_status text;
  review_id uuid;
  publication_id uuid;
  app_notification_id uuid;
  next_revision integer;
  config_whatsapp_enabled boolean;
  config_app_enabled boolean;
  changed_helper_ids uuid[] := '{}'::uuid[];
  changed integer := 0;
  saved integer := 0;
  publication_ids jsonb := '[]'::jsonb;
  whatsapp_publication_ids jsonb := '[]'::jsonb;
  app_notification_ids jsonb := '[]'::jsonb;
  current_dependency_hash text;
  current_source_change_id bigint;
begin
  if p_company is null or p_actor is null then
    raise exception 'Company and publisher are required.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Send Notification is available only for one complete calendar month.';
  end if;
  if p_review_until is null or p_review_until <= now() then
    raise exception 'A future payout dispute deadline is required.';
  end if;
  if p_notify_at is null or p_notify_at >= p_review_until then
    raise exception 'Notification time must precede the payout dispute deadline.';
  end if;
  if p_notification_config_id is null or p_notification_config_updated_at is null then
    raise exception 'The payout notification configuration is required.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one Helper payout.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Submit at most 1000 payouts at a time.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', '')),
      lower(nullif(selected ->> 'location_id', ''))
    having count(*) > 1
  ) then
    raise exception 'The same Helper payout location was selected more than once.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', ''))
    having count(*) filter (
      where coalesce((selected ->> 'notification_primary')::boolean, false)
    ) <> 1
  ) then
    raise exception 'Exactly one notification must be queued for each Helper.';
  end if;

  perform 1
  from public.helpers helper
  where helper.company_id = p_company
    and helper.id in (
      select distinct nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
  order by helper.id
  for update;

  if (
    select count(*)
    from public.helpers helper
    where helper.company_id = p_company
      and helper.is_active is true
      and helper.onboarding_status = 'active'
      and helper.id in (
        select distinct nullif(selected ->> 'subject_id', '')::uuid
        from jsonb_array_elements(p_items) selected
      )
  ) <> (
    select count(distinct nullif(selected ->> 'subject_id', '')::uuid)
    from jsonb_array_elements(p_items) selected
  ) then
    raise exception 'A selected Helper payout is no longer available.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'helper-payout-publication:' || p_company::text,
    0
  ));

  -- Shared payout dependencies use the same company mutex as their revision
  -- triggers. The route reloads Helper rows between two dependency reads and
  -- supplies the accepted values in each server-built item; compare them only
  -- after all selected Helper rows and this company mutex are locked.
  perform public.lock_workforce_payment_allocation_company(p_company);
  current_dependency_hash := public.helper_payout_shared_dependency_hash(
    p_company, p_period_start, p_period_end
  );
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected(value)
    where lower(btrim(coalesce(selected.value ->> 'expected_dependency_hash', '')))
      is distinct from current_dependency_hash
  ) then
    raise exception 'Payout inputs changed while Helper payouts were loading. Refresh and review the recalculated amounts.';
  end if;

  select config.is_enabled, coalesce(config.app_notification_enabled, false)
  into config_whatsapp_enabled, config_app_enabled
  from public.whatsapp_notification_configs config
  where config.company_id = p_company
    and config.id = p_notification_config_id
    and config.event_code = 'workforce_payout_review'
    and config.updated_at = p_notification_config_updated_at;
  if not found then
    raise exception 'The payout notification setting changed. Review the setting and try again.';
  end if;
  if not config_whatsapp_enabled and not config_app_enabled then
    raise exception 'Enable App or WhatsApp notifications before publishing payouts.';
  end if;

  if config_whatsapp_enabled and not exists (
    select 1
    from public.whatsapp_notification_configs config
    join public.whatsapp_profiles profile
      on profile.company_id = config.company_id
     and profile.id = config.whatsapp_profile_id
     and profile.is_active is true
     and nullif(btrim(profile.phone_number_id), '') is not null
    join public.whatsapp_template_cache template
      on template.company_id = config.company_id
     and template.whatsapp_profile_id = config.whatsapp_profile_id
     and template.template_id = config.template_id
     and template.name = config.template_name
     and template.language = config.template_language
     and upper(template.status) = 'APPROVED'
    join public.whatsapp_settings settings
      on settings.company_id = config.company_id
     and settings.is_enabled is true
    where config.company_id = p_company
      and config.id = p_notification_config_id
      and config.event_code = 'workforce_payout_review'
      and config.is_enabled is true
      and config.updated_at = p_notification_config_updated_at
      and jsonb_typeof(config.variable_mappings) = 'object'
  ) then
    raise exception 'The payout WhatsApp notification setting changed or is no longer ready. Review the setting and try again.';
  end if;

  -- Freeze the revision decision before inserting any row. Otherwise the
  -- first location inserted in a multi-location cohort would make a later
  -- unchanged sibling appear to be a same-snapshot replay.
  select coalesce(
    array_agg(distinct nullif(selected ->> 'subject_id', '')::uuid),
    '{}'::uuid[]
  )
  into changed_helper_ids
  from jsonb_array_elements(p_items) selected
  left join lateral (
    select publication.snapshot_hash,
      publication.payout_dependency_hash,
      publication.payout_source_change_id
    from public.helper_payout_publications publication
    where publication.company_id = p_company
      and publication.helper_id = nullif(selected ->> 'subject_id', '')::uuid
      and publication.station_id = nullif(selected ->> 'location_id', '')::uuid
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1
  ) latest on true
  where latest.snapshot_hash is null
    or latest.snapshot_hash is distinct from nullif(btrim(selected ->> 'snapshot_hash'), '')
    or latest.payout_dependency_hash is distinct from lower(btrim(selected ->> 'expected_dependency_hash'))
    or latest.payout_source_change_id is distinct from (selected ->> 'expected_source_change_id')::bigint;

  update public.helper_payout_publications publication
  set notification_status = 'superseded'
  where publication.company_id = p_company
    and publication.helper_id in (
      select distinct nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
    and publication.notification_status in ('pending', 'failed');

  for item in select value from jsonb_array_elements(p_items)
  loop
    if lower(btrim(item ->> 'subject_type')) <> 'helper' then
      raise exception 'Send Notification accepts Helper payouts only.';
    end if;
    item_subject := nullif(item ->> 'subject_id', '')::uuid;
    item_location := nullif(item ->> 'location_id', '')::uuid;
    item_expected_status := lower(btrim(item ->> 'expected_status'));
    item_snapshot := item -> 'calculation_snapshot';
    item_snapshot_hash := nullif(btrim(item ->> 'snapshot_hash'), '');
    item_notification_snapshot := item -> 'notification_config_snapshot';
    item_notification_primary := coalesce((item ->> 'notification_primary')::boolean, false);
    item_expected_dependency_hash := lower(btrim(coalesce(item ->> 'expected_dependency_hash', '')));
    item_expected_source_change_id := case
      when coalesce(item ->> 'expected_source_change_id', '') ~ '^[0-9]+$'
        then (item ->> 'expected_source_change_id')::bigint
      else null
    end;

    if item_subject is null or item_location is null
      or item_expected_status not in ('ready', 'returned')
      or jsonb_typeof(item_snapshot) <> 'object'
      or item_snapshot ->> 'schema_version' <> '2'
      or item_snapshot ->> 'source' <> 'helper_payout_worksheet'
      or item_snapshot #>> '{run,period_start}' <> p_period_start::text
      or item_snapshot #>> '{run,period_end}' <> p_period_end::text
      or item_snapshot #>> '{item,helper_id}' <> item_subject::text
      or item_snapshot #>> '{item,station_id}' <> item_location::text
      or item_snapshot_hash is null
      or item_expected_dependency_hash !~ '^[0-9a-f]{32}$'
      or item_expected_source_change_id is null
      or jsonb_typeof(item_notification_snapshot) <> 'object'
      or item_notification_snapshot ->> 'schema_version' <> '1'
      or item_notification_snapshot ->> 'event_code' <> 'workforce_payout_review'
      or jsonb_typeof(item_notification_snapshot -> 'app_notification_enabled') <> 'boolean'
      or jsonb_typeof(item_notification_snapshot -> 'whatsapp_notification_enabled') <> 'boolean'
      or coalesce((item_notification_snapshot ->> 'app_notification_enabled')::boolean, false)
        is distinct from config_app_enabled
      or coalesce((item_notification_snapshot ->> 'whatsapp_notification_enabled')::boolean, false)
        is distinct from config_whatsapp_enabled
      or jsonb_typeof(item_notification_snapshot -> 'resolved_values') <> 'object'
    then
      raise exception 'A selected Helper payout snapshot is invalid.';
    end if;

    select coalesce(max(change.id), 0)
    into current_source_change_id
    from public.helper_payout_dependency_changes change
    where change.company_id = p_company
      and change.helper_id = item_subject
      and daterange(change.effective_from, coalesce(change.effective_to, 'infinity'::date), '[]')
        && daterange(p_period_start, p_period_end, '[]');
    if item_expected_dependency_hash is distinct from current_dependency_hash
      or item_expected_source_change_id is distinct from current_source_change_id
    then
      raise exception 'Payout inputs changed while Helper payouts were loading. Refresh and review the recalculated amounts.';
    end if;

    if (
      select array_agg(key order by key)
      from jsonb_object_keys(item_notification_snapshot -> 'resolved_values') key
    ) is distinct from array[
      'deduction_amount','dropx_id','full_name','gross_amount','net_amount',
      'payment_label','payout_period','payout_url','review_deadline','station_code','work_days'
    ]::text[]
      or exists (
        select 1
        from jsonb_each(item_notification_snapshot -> 'resolved_values') value
        where jsonb_typeof(value.value) <> 'string'
      )
      or item_notification_snapshot #>> '{resolved_values,payout_url}'
        !~ '^https://one[.]dropxlogistics[.]com/payments[?]'
    then
      raise exception 'The Helper payout notification values are incomplete.';
    end if;

    if config_whatsapp_enabled then
      if item_notification_snapshot ->> 'whatsapp_profile_id' is null
        or item_notification_snapshot ->> 'template_id' is null
        or nullif(item_notification_snapshot ->> 'recipient', '') is null
        or item_notification_snapshot ->> 'recipient' !~ '^[0-9]{11,15}$'
        or jsonb_typeof(item_notification_snapshot -> 'variable_mappings') <> 'object'
        or jsonb_typeof(item_notification_snapshot -> 'template_components') <> 'array'
      then
        raise exception 'The Helper payout WhatsApp notification snapshot is invalid.';
      end if;
      if not exists (
        select 1
        from public.whatsapp_notification_configs config
        join public.whatsapp_template_cache template
          on template.company_id = config.company_id
         and template.whatsapp_profile_id = config.whatsapp_profile_id
         and template.template_id = config.template_id
         and template.name = config.template_name
         and template.language = config.template_language
         and upper(template.status) = 'APPROVED'
        where config.company_id = p_company
          and config.id = p_notification_config_id
          and item_notification_snapshot ->> 'whatsapp_profile_id' = config.whatsapp_profile_id::text
          and item_notification_snapshot ->> 'template_id' = config.template_id
          and item_notification_snapshot ->> 'template_name' = config.template_name
          and item_notification_snapshot ->> 'template_language' = config.template_language
          and item_notification_snapshot -> 'variable_mappings' = config.variable_mappings
          and item_notification_snapshot -> 'template_components' = template.components
      ) then
        raise exception 'The Helper payout WhatsApp snapshot does not match the saved setting.';
      end if;
      if not exists (
        select 1
        from public.helpers helper
        where helper.company_id = p_company
          and helper.id = item_subject
          and item_notification_snapshot ->> 'recipient' = case
            when length(regexp_replace(coalesce(helper.mobile, ''), '[^0-9]', '', 'g')) > 10
              and left(
                regexp_replace(coalesce(helper.mobile, ''), '[^0-9]', '', 'g'),
                length(coalesce(nullif(regexp_replace(coalesce(helper.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91'))
              ) = coalesce(nullif(regexp_replace(coalesce(helper.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
            then regexp_replace(coalesce(helper.mobile, ''), '[^0-9]', '', 'g')
            else coalesce(nullif(regexp_replace(coalesce(helper.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
              || regexp_replace(coalesce(helper.mobile, ''), '[^0-9]', '', 'g')
          end
      ) then
        raise exception 'A selected Helper does not have a valid WhatsApp mobile number.';
      end if;
    end if;

    if p_locations is not null and not (item_location = any(p_locations)) then
      raise exception 'A selected Helper payout is outside your location scope.';
    end if;
    if not exists (
      select 1
      from public.stations station
      where station.company_id = p_company
        and station.id = item_location
        and station.is_active is true
    ) then
      raise exception 'A selected Helper payout location is unavailable.';
    end if;

    existing_review_status := null;
    select existing.status
    into existing_review_status
    from public.workforce_payout_review_submissions existing
    where existing.company_id = p_company
      and existing.subject_type = 'helper'
      and existing.subject_id = item_subject
      and existing.location_id = item_location
      and existing.period_start = p_period_start
      and existing.period_end = p_period_end;

    -- A Helper notification is profile-wide, so a changed location requires a
    -- coherent new revision for every selected location. Unchanged sibling
    -- rows are allowed only when the pre-insert cohort comparison found at
    -- least one changed or newly-added location for this Helper.
    helper_has_snapshot_change := item_subject = any(changed_helper_ids);

    if item_expected_status = 'ready' then
      if existing_review_status is not null
        and (existing_review_status not in ('under_review', 'approved')
        or not helper_has_snapshot_change
        ) then
        raise exception 'The Helper payout publication state changed. Refresh the worksheet and try again.';
      end if;
    elsif item_expected_status = 'returned' and existing_review_status is distinct from 'returned' then
      raise exception 'The Helper payout publication state changed. Refresh the worksheet and try again.';
    end if;

    review_next_status := case
      when existing_review_status = 'approved' then 'approved'
      else 'under_review'
    end;

    insert into public.workforce_payout_review_submissions (
      company_id, subject_type, subject_id, location_id,
      period_start, period_end, status, calculation_snapshot,
      submitted_by, submitted_at, updated_at
    ) values (
      p_company, 'helper', item_subject, item_location,
      p_period_start, p_period_end, review_next_status, item_snapshot,
      p_actor, now(), now()
    )
    on conflict (company_id, subject_type, subject_id, location_id, period_start, period_end)
    do update set
      status = excluded.status,
      calculation_snapshot = excluded.calculation_snapshot,
      submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at,
      updated_at = now()
    where (
        item_expected_status = 'returned'
        and workforce_payout_review_submissions.status = 'returned'
      ) or (
        item_expected_status = 'ready'
        and helper_has_snapshot_change
        and workforce_payout_review_submissions.status in ('under_review', 'approved')
      )
    returning id into review_id;

    get diagnostics changed = row_count;
    if changed <> 1 or review_id is null then
      raise exception 'The Helper payout publication state changed. Refresh the worksheet and try again.';
    end if;

    select coalesce(max(publication.revision), 0) + 1
    into next_revision
    from public.helper_payout_publications publication
    where publication.company_id = p_company
      and publication.helper_id = item_subject
      and publication.station_id = item_location
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;

    insert into public.helper_payout_publications (
      company_id, helper_id, station_id, revision,
      snapshot, snapshot_hash, review_submission_id,
      published_by, published_at, review_until, notify_at,
      notification_status, notification_config_snapshot,
      period_start, period_end
    ) values (
      p_company, item_subject, item_location, next_revision,
      item_snapshot, item_snapshot_hash, review_id,
      p_actor, now(), p_review_until, p_notify_at,
      case
        when not item_notification_primary then 'superseded'
        when config_whatsapp_enabled then 'pending'
        else 'disabled'
      end,
      item_notification_snapshot,
      p_period_start, p_period_end
    ) returning id into publication_id;

    saved := saved + 1;
    if item_notification_primary then
      publication_ids := publication_ids || jsonb_build_array(publication_id);
      if config_whatsapp_enabled then
        whatsapp_publication_ids := whatsapp_publication_ids || jsonb_build_array(publication_id);
      end if;
      if config_app_enabled then
        app_notification_id := null;
        insert into public.mob_app_notifications (
          company_id, recipient_profile_type, recipient_account_id,
          event_code, title, body, route, data, source_key,
          created_by, push_status
        ) values (
          p_company, 'worker', item_subject,
          'workforce_payout_review', 'Payment details available',
          format(
            '%s details for %s are now available in DropX One.',
            coalesce(nullif(item_notification_snapshot #>> '{resolved_values,payment_label}', ''), 'Payment'),
            coalesce(nullif(item_notification_snapshot #>> '{resolved_values,payout_period}', ''), to_char(p_period_start, 'Mon YYYY'))
          ),
          item_notification_snapshot #>> '{resolved_values,payout_url}',
          jsonb_build_object(
            'publicationId', publication_id,
            'publicationType', 'helper',
            'periodStart', p_period_start,
            'periodEnd', p_period_end,
            'payoutMonth', to_char(p_period_start, 'YYYY-MM'),
            'reviewUntil', p_review_until,
            'tab', 'payouts',
            'dropxId', item_notification_snapshot #>> '{resolved_values,dropx_id}',
            'dropxName', item_notification_snapshot #>> '{resolved_values,full_name}'
          ),
          'helper:' || publication_id::text, p_actor, 'not_configured'
        )
        on conflict (company_id, event_code, source_key, recipient_account_id) do nothing
        returning id into app_notification_id;
        if app_notification_id is null then
          raise exception 'The DropX One Helper payout notification could not be created.';
        end if;
        app_notification_ids := app_notification_ids || jsonb_build_array(app_notification_id);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'published', saved,
    'publication_ids', publication_ids,
    'whatsapp_publication_ids', whatsapp_publication_ids,
    'app_notification_ids', app_notification_ids
  );
end
$function$;

comment on function public.helper_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], timestamptz, timestamptz, uuid, timestamptz
) is
  'Atomically freezes monthly Helper payout snapshots and creates enabled worker-profile App and WhatsApp notification records.';
comment on table public.helper_payout_dependency_changes is
  'Immutable effective-dated change sequence used to publish and pay only stable Helper payout calculations.';
comment on column public.helper_payout_publications.payout_source_change_id is
  'Latest overlapping Helper-only payout input change across every location frozen with this publication.';
comment on column public.helper_payout_publications.payout_dependency_hash is
  'Stable company/month payout dependency revision frozen with this publication.';
comment on function public.helper_payout_dependency_state(uuid,date,date,jsonb) is
  'Returns the shared and Helper-wide dependency watermark used for a stable server reload and coherent location cohort.';

-- Enrich grouped payout history for both canonical Workforce accounts and
-- Helpers (DropX One profile type `worker`).
create or replace function public.mob_app_assign_payout_campaign()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  batch_id uuid;
  batch_code text;
  recipient_dropx_id text;
  recipient_name text;
begin
  if new.event_code <> 'workforce_payout_review' or new.campaign_id is not null then
    return new;
  end if;

  batch_id := (
    pg_catalog.md5(
      new.company_id::text || ':' ||
      pg_catalog.txid_current()::text || ':' ||
      new.event_code
    )
  )::uuid;
  batch_code := 'APP-PAYOUT-' || upper(replace(batch_id::text, '-', ''));

  insert into public.mob_app_notification_campaigns (
    id, company_id, event_code, campaign_code, created_by, created_at
  ) values (
    batch_id, new.company_id, new.event_code, batch_code, new.created_by, now()
  )
  on conflict (id) do nothing;

  new.campaign_id := batch_id;
  new.data := coalesce(new.data, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'batchId', batch_id::text,
    'campaignCode', batch_code
  );

  if new.recipient_profile_type = 'workforce' then
    select workforce.dropx_id, workforce.full_name
    into recipient_dropx_id, recipient_name
    from public.workforce workforce
    where workforce.company_id = new.company_id
      and workforce.id = new.recipient_account_id;
  elsif new.recipient_profile_type = 'worker' then
    select helper.dropx_id, helper.full_name
    into recipient_dropx_id, recipient_name
    from public.helpers helper
    where helper.company_id = new.company_id
      and helper.id = new.recipient_account_id;
  end if;

  if new.recipient_profile_type in ('workforce', 'worker') then
    new.data := new.data || pg_catalog.jsonb_build_object(
      'dropxId', coalesce(nullif(new.data ->> 'dropxId', ''), recipient_dropx_id, ''),
      'dropxName', coalesce(nullif(new.data ->> 'dropxName', ''), recipient_name, 'Workforce account')
    );
  end if;
  return new;
end
$function$;

revoke all on function public.guard_helper_payout_publication_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_dependency_change_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.record_helper_payout_dependency_change()
  from public, anon, authenticated, service_role;
revoke all on function public.stamp_helper_payout_publication_dependencies()
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_shared_dependency_hash(uuid,date,date)
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_dependency_state(uuid,date,date,jsonb)
  from public, anon, authenticated;
revoke all on function public.helper_claim_payout_review_notification(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.helper_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], timestamptz, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.helper_claim_payout_review_notification(uuid, timestamptz)
  to service_role;
grant execute on function public.helper_payout_dependency_state(uuid,date,date,jsonb)
  to service_role;
grant execute on function public.helper_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], timestamptz, timestamptz, uuid, timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
