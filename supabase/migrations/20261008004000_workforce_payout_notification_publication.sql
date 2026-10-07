begin;

-- The worksheet is the calculation authority for the new notification flow.
-- Keep the original payroll-run publication path intact, but allow a second,
-- explicitly identified publication kind whose immutable snapshot comes from
-- the server-side worksheet loader.
create table if not exists public.workforce_payout_publications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  payroll_run_id uuid references public.workforce_payroll_runs(id),
  workforce_id uuid not null references public.workforce(id),
  station_id uuid not null references public.stations(id),
  revision integer not null,
  snapshot jsonb not null,
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(),
  review_until timestamptz not null,
  notify_at timestamptz not null,
  source_calculated_at timestamptz not null,
  notification_status text not null default 'pending',
  notification_error text,
  notification_reference text,
  notification_attempted_at timestamptz
);

alter table public.workforce_payout_publications
  alter column payroll_run_id drop not null,
  add column if not exists review_submission_id uuid,
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists snapshot_hash text,
  add column if not exists dependency_hash text,
  add column if not exists notification_config_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists publication_kind text not null default 'legacy_payroll';

do $block$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workforce_payout_publications'::regclass
      and conname = 'workforce_payout_publications_review_submission_fk'
  ) then
    alter table public.workforce_payout_publications
      add constraint workforce_payout_publications_review_submission_fk
      foreign key (review_submission_id)
      references public.workforce_payout_review_submissions(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workforce_payout_publications'::regclass
      and conname = 'workforce_payout_publications_source_check'
  ) then
    alter table public.workforce_payout_publications
      add constraint workforce_payout_publications_source_check check (
        (
          publication_kind = 'legacy_payroll'
          and payroll_run_id is not null
        )
        or (
          publication_kind = 'worksheet'
          and payroll_run_id is null
          and review_submission_id is not null
          and period_start is not null
          and period_end is not null
          and period_end >= period_start
          and nullif(btrim(snapshot_hash), '') is not null
          and nullif(btrim(dependency_hash), '') is not null
          and snapshot ->> 'schema_version' = '2'
          and jsonb_typeof(notification_config_snapshot) = 'object'
          and notification_config_snapshot ->> 'schema_version' = '1'
        )
      ) not valid;
  end if;
end
$block$;

create unique index if not exists workforce_payout_publications_worksheet_revision_uidx
  on public.workforce_payout_publications
  (company_id, workforce_id, station_id, period_start, period_end, revision)
  where publication_kind = 'worksheet';

create index if not exists workforce_payout_publications_worksheet_period_idx
  on public.workforce_payout_publications
  (company_id, workforce_id, period_start, period_end, published_at desc)
  where publication_kind = 'worksheet';

create index if not exists workforce_payout_publications_review_submission_idx
  on public.workforce_payout_publications(review_submission_id)
  where review_submission_id is not null;

create unique index if not exists workforce_payout_publications_payroll_run_id_workforce_id_r_key
  on public.workforce_payout_publications(payroll_run_id, workforce_id, revision)
  where payroll_run_id is not null;

create index if not exists workforce_payout_publications_person
  on public.workforce_payout_publications(company_id, workforce_id, published_at desc);

create index if not exists workforce_payout_notification_queue
  on public.workforce_payout_publications(notify_at)
  where notification_status = 'pending';

-- Production may already have the legacy five-state constraint. Replace it so
-- the intentional no-send station rows in a multi-location publication can be
-- recorded as superseded.
alter table public.workforce_payout_publications
  drop constraint if exists workforce_payout_publications_notification_status_check;
alter table public.workforce_payout_publications
  add constraint workforce_payout_publications_notification_status_check
  check (notification_status in (
    'pending', 'sending', 'sent', 'failed', 'uncertain', 'superseded'
  )) not valid;

alter table public.workforce_payout_publications enable row level security;
alter table public.workforce_payout_publications force row level security;
revoke all on table public.workforce_payout_publications
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.workforce_payout_publications
  to service_role;

-- These review objects existed in production before their source migration was
-- captured in this repository. Define them here so a fresh environment has the
-- same safe boundary as production and the Dashboard/DropX One flows do not
-- depend on schema drift.
create table if not exists public.workforce_payout_disputes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  publication_id uuid not null references public.workforce_payout_publications(id),
  payroll_run_id uuid references public.workforce_payroll_runs(id),
  workforce_id uuid not null references public.workforce(id),
  station_id uuid not null references public.stations(id),
  category text not null check (category in ('counts','training','loss','tds','other')),
  reason text not null check (length(btrim(reason)) between 10 and 2000),
  status text not null default 'open' check (status in ('open','in_review','resolved','rejected')),
  resolution text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  correction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workforce_payout_disputes
  alter column payroll_run_id drop not null;

create table if not exists public.workforce_payout_dispute_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  dispute_id uuid not null references public.workforce_payout_disputes(id),
  actor_id uuid,
  actor_name text not null,
  portal text not null check (portal in ('one','workforce','ops')),
  message text not null check (length(btrim(message)) between 3 and 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.workforce_payout_corrections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  payroll_run_id uuid not null references public.workforce_payroll_runs(id),
  workforce_id uuid not null references public.workforce(id),
  station_id uuid not null references public.stations(id),
  dispute_id uuid references public.workforce_payout_disputes(id),
  source_id uuid not null,
  kind text not null check (kind in ('counts','loss','tds','other')),
  payload jsonb not null,
  reason text not null check (length(btrim(reason)) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','superseded')),
  requested_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  review_remarks text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

do $block$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workforce_payout_disputes'::regclass
      and conname = 'payout_dispute_correction_fk'
  ) then
    alter table public.workforce_payout_disputes
      add constraint payout_dispute_correction_fk
      foreign key (correction_id)
      references public.workforce_payout_corrections(id);
  end if;
end
$block$;

create index if not exists workforce_payout_disputes_person
  on public.workforce_payout_disputes(company_id, workforce_id, created_at);
create index if not exists workforce_payout_disputes_run
  on public.workforce_payout_disputes(payroll_run_id, status);
create index if not exists workforce_payout_disputes_scope
  on public.workforce_payout_disputes(company_id, station_id, status);
create unique index if not exists workforce_payout_disputes_open_category_uidx
  on public.workforce_payout_disputes(publication_id, category)
  where status in ('open', 'in_review');
create index if not exists workforce_payout_dispute_event_history
  on public.workforce_payout_dispute_events(dispute_id, created_at);
create index if not exists workforce_payout_correction_dispute
  on public.workforce_payout_corrections(dispute_id);
create unique index if not exists workforce_payout_correction_open_source
  on public.workforce_payout_corrections(company_id, payroll_run_id, workforce_id, source_id)
  where status = 'pending';
create unique index if not exists workforce_payout_correction_approved_source
  on public.workforce_payout_corrections(company_id, payroll_run_id, workforce_id, source_id)
  where status = 'approved';

alter table public.workforce_payout_disputes enable row level security;
alter table public.workforce_payout_disputes force row level security;
alter table public.workforce_payout_dispute_events enable row level security;
alter table public.workforce_payout_dispute_events force row level security;
alter table public.workforce_payout_corrections enable row level security;
alter table public.workforce_payout_corrections force row level security;
revoke all on table public.workforce_payout_disputes,
  public.workforce_payout_dispute_events,
  public.workforce_payout_corrections
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.workforce_payout_disputes,
  public.workforce_payout_dispute_events,
  public.workforce_payout_corrections
  to service_role;

create or replace function public.guard_workforce_payout_publication_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (to_jsonb(new) - array[
      'notification_status',
      'notification_error',
      'notification_reference',
      'notification_attempted_at',
      'notify_at'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'notification_status',
      'notification_error',
      'notification_reference',
      'notification_attempted_at',
      'notify_at'
    ]::text[])
  then
    raise exception 'A published Workforce payout snapshot is immutable. Publish a new revision instead.';
  end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_publications_00_immutable
  on public.workforce_payout_publications;
create trigger workforce_payout_publications_00_immutable
before update on public.workforce_payout_publications
for each row execute function public.guard_workforce_payout_publication_immutable();

-- A modern publication is the financial source of truth shown in DropX One.
-- Provider and direct-allocation definitions that contributed to its month are
-- frozen immediately, independently of WhatsApp delivery success.
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

  select publication.period_start, publication.period_end
  into locked
  from public.workforce_payout_publications publication
  where publication.publication_kind = 'worksheet'
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
      'Workforce payout % to % was published to DropX One; provider mapping or remapping is locked for that period.',
      locked.period_start, locked.period_end;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists field_executive_provider_mappings_00_published_payout_guard
  on public.field_executive_provider_mappings;
create trigger field_executive_provider_mappings_00_published_payout_guard
before insert or update or delete on public.field_executive_provider_mappings
for each row execute function public.guard_published_workforce_provider_mapping();

create or replace function public.guard_published_workforce_direct_allocation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
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

  if tg_op in ('UPDATE', 'DELETE') and lower(coalesce(old.status, '')) <> 'cancelled' then
    old_range := daterange(old.effective_from, coalesce(old.effective_to, 'infinity'::date), '[]');
  end if;
  if tg_op <> 'DELETE' and lower(coalesce(new.status, '')) <> 'cancelled' then
    new_range := daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]');
  end if;
  if tg_op = 'UPDATE' then
    definition_changed := (to_jsonb(old) - array['updated_at','effective_from','effective_to','status']::text[])
      is distinct from
      (to_jsonb(new) - array['updated_at','effective_from','effective_to','status']::text[]);
  end if;

  perform 1
  from public.workforce workforce
  where (tg_op in ('UPDATE', 'DELETE') and workforce.company_id = old.company_id and workforce.id = old.workforce_id)
     or (tg_op <> 'DELETE' and workforce.company_id = new.company_id and workforce.id = new.workforce_id)
  order by workforce.company_id, workforce.id
  for update;

  for locked in
    select distinct company_id
    from (
      select case when tg_op in ('UPDATE', 'DELETE') then old.company_id end as company_id
      union
      select case when tg_op <> 'DELETE' then new.company_id end
    ) companies
    where company_id is not null
    order by company_id
  loop
    perform public.lock_workforce_payment_allocation_company(locked.company_id);
  end loop;

  select publication.period_start, publication.period_end
  into locked
  from public.workforce_payout_publications publication
  where publication.publication_kind = 'worksheet'
    and (
      (
        tg_op in ('UPDATE', 'DELETE')
        and publication.company_id = old.company_id
        and publication.workforce_id = old.workforce_id
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
        tg_op <> 'DELETE'
        and publication.company_id = new.company_id
        and publication.workforce_id = new.workforce_id
        and definition_changed
        and daterange(publication.period_start, publication.period_end, '[]') && new_range
      )
    )
  order by publication.period_start, publication.period_end, publication.id
  limit 1;

  if found then
    raise exception
      'Workforce payout % to % was published to DropX One; direct payment allocation changes are locked for that period.',
      locked.period_start, locked.period_end;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists workforce_payment_allocations_00_published_payout_guard
  on public.workforce_payment_allocations;
create trigger workforce_payment_allocations_00_published_payout_guard
before insert or update or delete on public.workforce_payment_allocations
for each row execute function public.guard_published_workforce_direct_allocation();

-- The route builds the financial snapshot from current database rows. This RPC
-- takes the same locks as every mapping writer, rechecks the signed dependency
-- version, records the review state, publishes the snapshot and queues the
-- notification as one transaction.
create or replace function public.workforce_publish_payout_notifications(
  p_company uuid,
  p_actor uuid,
  p_period_start date,
  p_period_end date,
  p_items jsonb,
  p_locations uuid[] default null,
  p_expected_dependency_hash text default null,
  p_review_until timestamptz default null,
  p_notify_at timestamptz default now(),
  p_notification_config_id uuid default null,
  p_notification_config_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
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
  review_id uuid;
  publication_id uuid;
  next_revision integer;
  current_dependency_hash text;
  saved integer := 0;
  changed integer := 0;
  publication_ids jsonb := '[]'::jsonb;
begin
  if p_company is null or p_actor is null then
    raise exception 'Company and publisher are required';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Send Notification is available only for one complete calendar month';
  end if;
  if p_review_until is null or p_review_until <= now() then
    raise exception 'A future payout dispute deadline is required';
  end if;
  if p_notify_at is null or p_notify_at >= p_review_until then
    raise exception 'Notification time must precede the payout dispute deadline';
  end if;
  if nullif(btrim(p_expected_dependency_hash), '') is null then
    raise exception 'The payout worksheet version is required';
  end if;
  if p_notification_config_id is null or p_notification_config_updated_at is null then
    raise exception 'The payout WhatsApp notification configuration is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one Workforce payout';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Submit at most 1000 payouts at a time';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', '')),
      lower(nullif(selected ->> 'location_id', ''))
    having count(*) > 1
  ) then
    raise exception 'The same Workforce payout location was selected more than once';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) selected
    group by lower(nullif(selected ->> 'subject_id', ''))
    having count(*) filter (where coalesce((selected ->> 'notification_primary')::boolean, false)) <> 1
  ) then
    raise exception 'Exactly one WhatsApp notification must be queued for each DropX ID';
  end if;

  -- Lock every selected identity in UUID order before the shared company mutex.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id in (
      select nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
  order by workforce.id
  for update;

  if (select count(*) from public.workforce workforce
      where workforce.company_id = p_company
        and workforce.deleted_at is null
        and workforce.migration_state <> 'reclassified'
        and workforce.id in (
          select nullif(selected ->> 'subject_id', '')::uuid
          from jsonb_array_elements(p_items) selected
         )) <> (
           select count(distinct nullif(selected ->> 'subject_id', '')::uuid)
           from jsonb_array_elements(p_items) selected
         )
  then
    raise exception 'A selected Workforce payout is no longer available';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company);
  current_dependency_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company, p_period_start, p_period_end
  );
  if current_dependency_hash is distinct from p_expected_dependency_hash then
    raise exception 'Payout inputs changed after this worksheet was displayed. Refresh the page and review the recalculated amounts.';
  end if;

  if not exists (
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

  -- Supersede only publications from an earlier transaction. All station
  -- snapshots for this request are inserted below and share one notification.
  update public.workforce_payout_publications publication
  set notification_status = 'superseded'
  where publication.company_id = p_company
    and publication.workforce_id in (
      select distinct nullif(selected ->> 'subject_id', '')::uuid
      from jsonb_array_elements(p_items) selected
    )
    and publication.publication_kind = 'worksheet'
    and publication.period_start = p_period_start
    and publication.period_end = p_period_end
    and publication.notification_status in ('pending', 'failed');

  for item in select value from jsonb_array_elements(p_items)
  loop
    if lower(btrim(item ->> 'subject_type')) <> 'workforce' then
      raise exception 'Send Notification is available only for Workforce payouts';
    end if;
    item_subject := nullif(item ->> 'subject_id', '')::uuid;
    item_location := nullif(item ->> 'location_id', '')::uuid;
    item_expected_status := lower(btrim(item ->> 'expected_status'));
    item_snapshot := item -> 'calculation_snapshot';
    item_snapshot_hash := nullif(btrim(item ->> 'snapshot_hash'), '');
    item_notification_snapshot := item -> 'notification_config_snapshot';
    item_notification_primary := coalesce((item ->> 'notification_primary')::boolean, false);

    if item_subject is null or item_location is null
      or item_expected_status not in ('ready', 'returned')
      or jsonb_typeof(item_snapshot) <> 'object'
      or item_snapshot ->> 'schema_version' <> '2'
      or item_snapshot ->> 'source' <> 'workforce_payout_worksheet'
      or item_snapshot #>> '{run,period_start}' <> p_period_start::text
      or item_snapshot #>> '{run,period_end}' <> p_period_end::text
      or item_snapshot #>> '{item,workforce_id}' <> item_subject::text
      or item_snapshot #>> '{item,station_id}' <> item_location::text
      or item_snapshot_hash is null
      or jsonb_typeof(item_notification_snapshot) <> 'object'
      or item_notification_snapshot ->> 'schema_version' <> '1'
      or item_notification_snapshot ->> 'event_code' <> 'workforce_payout_review'
      or item_notification_snapshot ->> 'whatsapp_profile_id' is null
      or item_notification_snapshot ->> 'template_id' is null
      or nullif(item_notification_snapshot ->> 'recipient', '') is null
      or item_notification_snapshot ->> 'recipient' !~ '^[0-9]{11,15}$'
      or jsonb_typeof(item_notification_snapshot -> 'variable_mappings') <> 'object'
      or jsonb_typeof(item_notification_snapshot -> 'template_components') <> 'array'
      or jsonb_typeof(item_notification_snapshot -> 'resolved_values') <> 'object'
    then
      raise exception 'A selected payout snapshot is invalid';
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
    then
      raise exception 'The payout WhatsApp notification values are incomplete';
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
      raise exception 'The payout WhatsApp notification snapshot does not match the saved setting';
    end if;
    if not exists (
      select 1
      from public.workforce workforce
      where workforce.company_id = p_company
        and workforce.id = item_subject
        and item_notification_snapshot ->> 'recipient' = case
          when length(regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')) > 10
            and left(
              regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g'),
              length(coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91'))
            ) = coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
          then regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')
          else coalesce(nullif(regexp_replace(coalesce(workforce.mobile_country_code, '91'), '[^0-9]', '', 'g'), ''), '91')
            || regexp_replace(coalesce(workforce.mobile, ''), '[^0-9]', '', 'g')
        end
    ) then
      raise exception 'A selected Workforce member does not have a valid WhatsApp mobile number';
    end if;
    if p_locations is not null and not (item_location = any(p_locations)) then
      raise exception 'A selected payout is outside your location scope';
    end if;
    if not exists (
      select 1 from public.stations station
      where station.company_id = p_company and station.id = item_location
    ) then
      raise exception 'A selected payout location is unavailable';
    end if;

    if item_expected_status = 'ready' and exists (
      select 1 from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = 'workforce'
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
    ) then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;
    if item_expected_status = 'returned' and not exists (
      select 1 from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = 'workforce'
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
        and existing.status = 'returned'
    ) then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;

    insert into public.workforce_payout_review_submissions (
      company_id, subject_type, subject_id, location_id,
      period_start, period_end, status, calculation_snapshot,
      submitted_by, submitted_at, updated_at
    ) values (
      p_company, 'workforce', item_subject, item_location,
      p_period_start, p_period_end, 'under_review', item_snapshot,
      p_actor, now(), now()
    )
    on conflict (company_id, subject_type, subject_id, location_id, period_start, period_end)
    do update set
      status = 'under_review',
      calculation_snapshot = excluded.calculation_snapshot,
      submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at,
      updated_at = now()
    where item_expected_status = 'returned'
      and workforce_payout_review_submissions.status = 'returned'
    returning id into review_id;

    get diagnostics changed = row_count;
    if changed <> 1 or review_id is null then
      raise exception 'The payout publication state changed. Refresh the worksheet and try again.';
    end if;

    select coalesce(max(publication.revision), 0) + 1
    into next_revision
    from public.workforce_payout_publications publication
    where publication.company_id = p_company
      and publication.workforce_id = item_subject
      and publication.publication_kind = 'worksheet'
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end;

    insert into public.workforce_payout_publications (
      company_id, payroll_run_id, workforce_id, station_id, revision,
      snapshot, published_by, published_at, review_until, notify_at,
      source_calculated_at, notification_status, review_submission_id,
      period_start, period_end, snapshot_hash, dependency_hash,
      notification_config_snapshot, publication_kind
    ) values (
      p_company, null, item_subject, item_location, next_revision,
      item_snapshot, p_actor, now(), p_review_until, p_notify_at,
      clock_timestamp(), case when item_notification_primary then 'pending' else 'superseded' end, review_id,
      p_period_start, p_period_end, item_snapshot_hash,
      p_expected_dependency_hash, item_notification_snapshot, 'worksheet'
    ) returning id into publication_id;

    saved := saved + 1;
    if item_notification_primary then
      publication_ids := publication_ids || jsonb_build_array(publication_id);
    end if;
  end loop;

  return jsonb_build_object('published', saved, 'publication_ids', publication_ids);
end
$function$;

comment on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) is
  'Atomically revalidates a signed monthly worksheet version, publishes immutable per-Workforce snapshots to DropX One, freezes overlapping provider/direct mappings and queues notification delivery.';

-- Modern worksheet publications have no legacy payroll run. Disputes retain
-- their publication FK as the authoritative identity.
alter table if exists public.workforce_payout_disputes
  alter column payroll_run_id drop not null;

create or replace function public.workforce_raise_payout_dispute(
  p_company uuid,
  p_workforce uuid,
  p_publication uuid,
  p_category text,
  p_reason text
)
returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  pub public.workforce_payout_publications;
  run public.workforce_payroll_runs;
  dispute_id uuid;
begin
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company and workforce.id = p_workforce
  for update;

  select * into pub
  from public.workforce_payout_publications
  where id = p_publication
    and company_id = p_company
    and workforce_id = p_workforce;
  if not found then raise exception 'Payout is not available for this associate'; end if;

  if pub.publication_kind = 'worksheet' then
    if exists (
      select 1 from public.workforce_payout_publications newer
      where newer.company_id = pub.company_id
        and newer.workforce_id = pub.workforce_id
        and newer.publication_kind = 'worksheet'
        and newer.period_start = pub.period_start
        and newer.period_end = pub.period_end
        and newer.station_id = pub.station_id
        and newer.revision > pub.revision
    ) then
      raise exception 'Open the latest payout version before raising a dispute';
    end if;
  else
    select * into run
    from public.workforce_payroll_runs
    where id = pub.payroll_run_id and company_id = p_company
    for update;
    if run.status not in ('draft', 'review') then
      raise exception 'This payout is already confirmed. Contact support for a correction in the next open period';
    end if;
    if exists (
      select 1 from public.workforce_payout_publications newer
      where newer.payroll_run_id = pub.payroll_run_id
        and newer.workforce_id = p_workforce
        and newer.revision > pub.revision
    ) then
      raise exception 'Open the latest payout version before raising a dispute';
    end if;
  end if;

  if pub.review_until <= now() then
    raise exception 'The review window for this payout has ended';
  end if;
  if exists (
    select 1
    from public.workforce_payout_disputes dispute
    join public.workforce_payout_publications disputed_publication
      on disputed_publication.id = dispute.publication_id
    where dispute.category = p_category
      and dispute.status in ('open', 'in_review')
      and (
        (pub.publication_kind = 'worksheet'
          and disputed_publication.company_id = pub.company_id
          and disputed_publication.workforce_id = pub.workforce_id
          and disputed_publication.publication_kind = 'worksheet'
          and disputed_publication.station_id = pub.station_id
          and disputed_publication.period_start = pub.period_start
          and disputed_publication.period_end = pub.period_end)
        or (pub.publication_kind <> 'worksheet' and dispute.publication_id = p_publication)
      )
  ) then
    raise exception 'An open dispute already exists for this category. Add a reply to it';
  end if;

  insert into public.workforce_payout_disputes (
    company_id, publication_id, payroll_run_id, workforce_id,
    station_id, category, reason
  ) values (
    p_company, p_publication, pub.payroll_run_id, p_workforce,
    pub.station_id, p_category, btrim(p_reason)
  ) returning id into dispute_id;

  insert into public.workforce_payout_dispute_events (
    company_id, dispute_id, actor_name, portal, message
  ) values (
    p_company, dispute_id,
    coalesce(pub.snapshot -> 'item' ->> 'worker_name', 'Associate'),
    'one', btrim(p_reason)
  );
  return dispute_id;
end
$function$;

create or replace function public.workforce_reply_payout_dispute(
  p_company uuid,
  p_workforce uuid,
  p_dispute uuid,
  p_message text
)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  dispute public.workforce_payout_disputes;
begin
  select * into dispute
  from public.workforce_payout_disputes
  where company_id = p_company and workforce_id = p_workforce and id = p_dispute;
  if not found then raise exception 'Dispute not found'; end if;

  if dispute.payroll_run_id is not null then
    perform 1 from public.workforce_payroll_runs where id = dispute.payroll_run_id for update;
  else
    perform 1 from public.workforce_payout_publications where id = dispute.publication_id for update;
  end if;
  select * into dispute from public.workforce_payout_disputes where id = p_dispute for update;
  if dispute.status not in ('open', 'in_review') then raise exception 'This dispute is closed'; end if;
  insert into public.workforce_payout_dispute_events(
    company_id, dispute_id, actor_name, portal, message
  ) values (
    p_company, dispute.id, 'Associate', 'one', btrim(p_message)
  );
end
$function$;

create or replace function public.workforce_retry_payout_notice(
  p_company uuid,
  p_actor uuid,
  p_id uuid,
  p_locations uuid[]
)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  publication public.workforce_payout_publications;
  run public.workforce_payroll_runs;
begin
  select * into publication
  from public.workforce_payout_publications
  where id = p_id and company_id = p_company;
  if not found or p_actor is null then
    raise exception 'Publication is outside your station scope';
  end if;

  if publication.publication_kind = 'worksheet' then
    if p_locations is not null then
      raise exception 'Company-wide location access is required to retry a worksheet payout notification';
    end if;
    perform 1
    from public.workforce workforce
    where workforce.company_id = p_company and workforce.id = publication.workforce_id
    for update;
    if publication.review_until <= now() or exists (
      select 1 from public.workforce_payout_publications newer
      where newer.company_id = publication.company_id
        and newer.workforce_id = publication.workforce_id
        and newer.publication_kind = 'worksheet'
        and newer.period_start = publication.period_start
        and newer.period_end = publication.period_end
        and newer.station_id = publication.station_id
        and newer.revision > publication.revision
    ) then
      raise exception 'Only the latest payout within its review window can be notified';
    end if;
  else
    if p_locations is not null and not (publication.station_id = any(p_locations)) then
      raise exception 'Publication is outside your station scope';
    end if;
    select * into run
    from public.workforce_payroll_runs
    where id = publication.payroll_run_id and company_id = p_company
    for update;
    if run.status <> 'review'
      or run.calculated_at is distinct from publication.source_calculated_at
      or publication.review_until <= now()
    then
      raise exception 'Only a current payout within its review window can be notified';
    end if;
  end if;

  update public.workforce_payout_publications
  set notification_status = 'pending', notification_error = null, notify_at = now()
  where id = p_id and notification_status = 'failed';
  if not found then
    raise exception 'Only definite failures can be retried. Uncertain deliveries require operator verification';
  end if;

  if publication.payroll_run_id is not null then
    insert into public.workforce_payroll_events(
      company_id, payroll_run_id, event_code, actor_user_id, metadata
    ) values (
      p_company, publication.payroll_run_id, 'payout_notification_requeued', p_actor,
      jsonb_build_object('publication_id', p_id)
    );
  end if;
end
$function$;

create or replace function public.workforce_update_payout_dispute(
  p_company uuid,
  p_dispute uuid,
  p_actor uuid,
  p_actor_name text,
  p_portal text,
  p_status text,
  p_message text,
  p_correction uuid,
  p_locations uuid[]
)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  dispute public.workforce_payout_disputes;
  correction public.workforce_payout_corrections;
begin
  select * into dispute
  from public.workforce_payout_disputes
  where id = p_dispute and company_id = p_company;
  if not found or p_actor is null or p_portal not in ('workforce', 'ops')
    or (p_locations is not null and not (dispute.station_id = any(p_locations)))
  then
    raise exception 'Dispute is outside your scope';
  end if;

  if dispute.payroll_run_id is not null then
    perform 1 from public.workforce_payroll_runs where id = dispute.payroll_run_id for update;
  else
    perform 1 from public.workforce_payout_publications where id = dispute.publication_id for update;
  end if;
  select * into dispute from public.workforce_payout_disputes where id = p_dispute for update;
  if dispute.status in ('resolved', 'rejected') then raise exception 'This dispute is already closed'; end if;
  if length(btrim(coalesce(p_message, ''))) < 3
    or p_status not in ('in_review', 'resolved', 'rejected')
  then
    raise exception 'Record a reply and valid decision';
  end if;

  if p_correction is not null then
    if dispute.payroll_run_id is null then
      raise exception 'Publish a revised worksheet payout instead of linking a legacy payroll correction';
    end if;
    select * into correction
    from public.workforce_payout_corrections
    where id = p_correction
      and company_id = p_company
      and payroll_run_id = dispute.payroll_run_id
      and workforce_id = dispute.workforce_id
      and dispute_id = dispute.id;
    if not found or correction.status <> 'approved' then
      raise exception 'Correction must be independently approved';
    end if;
    if not exists (
      select 1 from public.workforce_payroll_lines
      where payroll_run_id = dispute.payroll_run_id
        and workforce_id = dispute.workforce_id
        and calculation_snapshot ->> 'correction_id' = correction.id::text
    ) then
      raise exception 'Recalculate payroll to include the correction before resolving';
    end if;
  end if;
  if p_status = 'resolved' and exists (
    select 1 from public.workforce_payout_corrections
    where dispute_id = dispute.id and status = 'pending'
  ) then
    raise exception 'Review the pending correction first';
  end if;
  if p_status = 'resolved' and exists (
    select 1 from public.workforce_payout_corrections
    where dispute_id = dispute.id and status = 'approved' and id is distinct from p_correction
  ) then
    raise exception 'Select the approved correction when resolving';
  end if;

  update public.workforce_payout_disputes
  set status = p_status,
      resolution = case when p_status in ('resolved', 'rejected') then p_message else null end,
      resolved_by = case when p_status in ('resolved', 'rejected') then p_actor else null end,
      resolved_at = case when p_status in ('resolved', 'rejected') then now() else null end,
      correction_id = p_correction,
      updated_at = now()
  where id = dispute.id;
  insert into public.workforce_payout_dispute_events(
    company_id, dispute_id, actor_id, actor_name, portal, message
  ) values (
    p_company, dispute.id, p_actor, p_actor_name, p_portal, p_message
  );
end
$function$;

-- Legacy payroll corrections remain available for legacy payroll-run
-- publications. Worksheet publications are corrected by recalculating and
-- publishing a new immutable worksheet revision instead.
create or replace function public.workforce_propose_payout_correction(
  p_company uuid,
  p_run uuid,
  p_workforce uuid,
  p_actor uuid,
  p_portal text,
  p_source uuid,
  p_kind text,
  p_payload jsonb,
  p_reason text,
  p_dispute uuid,
  p_locations uuid[]
)
returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  payroll_run public.workforce_payroll_runs;
  payroll_item record;
  correction_id uuid;
begin
  if p_company is null or p_run is null or p_workforce is null
    or p_actor is null or p_source is null
    or p_portal not in ('workforce', 'ops')
    or p_kind not in ('counts', 'loss', 'tds', 'other')
    or length(btrim(coalesce(p_reason, ''))) not between 10 and 2000
    or jsonb_typeof(p_payload) <> 'object'
  then
    raise exception 'Complete the correction request';
  end if;
  if (p_portal = 'ops' and p_kind not in ('counts', 'loss'))
    or (p_portal = 'workforce' and p_kind not in ('counts', 'tds', 'other'))
  then
    raise exception 'This correction type is unavailable in this portal';
  end if;
  if p_kind = 'counts' and (
    (select array_agg(key order by key) from jsonb_object_keys(p_payload) key)
      is distinct from array['customerReturn','mfn','mfnReturn','totalDelivery']::text[]
    or exists (
      select 1 from jsonb_each(p_payload) value
      where jsonb_typeof(value.value) <> 'number'
        or (value.value #>> '{}')::numeric < 0
        or trunc((value.value #>> '{}')::numeric) <> (value.value #>> '{}')::numeric
    )
  ) then
    raise exception 'Count corrections require non-negative whole-number activity counts';
  end if;
  if p_kind <> 'counts' and (
    (select array_agg(key order by key) from jsonb_object_keys(p_payload) key)
      is distinct from array['amount']::text[]
    or jsonb_typeof(p_payload -> 'amount') <> 'number'
  ) then
    raise exception 'Amount corrections require one numeric amount';
  end if;

  select * into payroll_run
  from public.workforce_payroll_runs
  where id = p_run and company_id = p_company
  for update;
  if not found or payroll_run.status not in ('draft', 'review') then
    raise exception 'Only an open payroll run can be corrected';
  end if;

  select item.id, item.station_id into payroll_item
  from public.workforce_payroll_items item
  where item.company_id = p_company
    and item.payroll_run_id = p_run
    and item.workforce_id = p_workforce
    and item.status <> 'excluded'
  limit 1;
  if not found
    or (p_locations is not null and not (payroll_item.station_id = any(p_locations)))
  then
    raise exception 'Payroll item is outside your station scope';
  end if;
  if not exists (
    select 1 from public.workforce_payroll_lines line
    where line.company_id = p_company
      and line.payroll_run_id = p_run
      and line.workforce_id = p_workforce
      and (line.id = p_source or line.source_id = p_source)
  ) then
    raise exception 'Correction source is unavailable';
  end if;
  if p_dispute is not null and not exists (
    select 1 from public.workforce_payout_disputes dispute
    where dispute.id = p_dispute
      and dispute.company_id = p_company
      and dispute.payroll_run_id = p_run
      and dispute.workforce_id = p_workforce
      and dispute.status in ('open', 'in_review')
  ) then
    raise exception 'Related dispute is unavailable';
  end if;

  insert into public.workforce_payout_corrections (
    company_id, payroll_run_id, workforce_id, station_id, dispute_id,
    source_id, kind, payload, reason, requested_by
  ) values (
    p_company, p_run, p_workforce, payroll_item.station_id, p_dispute,
    p_source, p_kind, p_payload, btrim(p_reason), p_actor
  ) returning id into correction_id;
  return correction_id;
end
$function$;

create or replace function public.workforce_review_payout_correction(
  p_company uuid,
  p_id uuid,
  p_actor uuid,
  p_decision text,
  p_remarks text,
  p_locations uuid[]
)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  correction public.workforce_payout_corrections;
  payroll_run public.workforce_payroll_runs;
begin
  if p_actor is null or p_decision not in ('approved', 'rejected')
    or length(btrim(coalesce(p_remarks, ''))) < 3
  then
    raise exception 'Record a valid correction decision and review reason';
  end if;
  select * into correction
  from public.workforce_payout_corrections
  where id = p_id and company_id = p_company;
  if not found
    or (p_locations is not null and not (correction.station_id = any(p_locations)))
  then
    raise exception 'Correction is outside your station scope';
  end if;
  if correction.requested_by = p_actor then
    raise exception 'A correction must be reviewed by a different user';
  end if;

  select * into payroll_run
  from public.workforce_payroll_runs
  where id = correction.payroll_run_id and company_id = p_company
  for update;
  if not found or payroll_run.status not in ('draft', 'review') then
    raise exception 'Only an open payroll run correction can be reviewed';
  end if;
  select * into correction
  from public.workforce_payout_corrections
  where id = p_id
  for update;
  if correction.status <> 'pending' then
    raise exception 'This correction was already reviewed';
  end if;

  if p_decision = 'approved' then
    update public.workforce_payout_corrections
    set status = 'superseded'
    where company_id = correction.company_id
      and payroll_run_id = correction.payroll_run_id
      and workforce_id = correction.workforce_id
      and source_id = correction.source_id
      and status = 'approved';
  end if;
  update public.workforce_payout_corrections
  set status = p_decision,
      reviewed_by = p_actor,
      review_remarks = btrim(p_remarks),
      reviewed_at = now()
  where id = correction.id;
end
$function$;

revoke all on function public.guard_workforce_payout_publication_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_published_workforce_provider_mapping()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_published_workforce_direct_allocation()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.workforce_publish_payout_notifications(
  uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
) to service_role;
revoke all on function public.workforce_raise_payout_dispute(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_raise_payout_dispute(uuid, uuid, uuid, text, text)
  to service_role;
revoke all on function public.workforce_reply_payout_dispute(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.workforce_reply_payout_dispute(uuid, uuid, uuid, text)
  to service_role;
revoke all on function public.workforce_retry_payout_notice(uuid, uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.workforce_retry_payout_notice(uuid, uuid, uuid, uuid[])
  to service_role;
revoke all on function public.workforce_update_payout_dispute(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_update_payout_dispute(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid[]
) to service_role;
revoke all on function public.workforce_propose_payout_correction(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, uuid, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_propose_payout_correction(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, uuid, uuid[]
) to service_role;
revoke all on function public.workforce_review_payout_correction(
  uuid, uuid, uuid, text, text, uuid[]
) from public, anon, authenticated;
grant execute on function public.workforce_review_payout_correction(
  uuid, uuid, uuid, text, text, uuid[]
) to service_role;

notify pgrst, 'reload schema';

commit;
