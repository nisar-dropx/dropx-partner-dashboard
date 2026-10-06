-- Selected Workforce and Helper payout estimates can be submitted for review
-- before a reviewer workflow is configured. This table records the exact
-- period and server-created submission metadata. It deliberately does not
-- trust client-calculated monetary amounts, because reviewer calculations
-- will be derived from source data when the approval workflow is introduced.
-- It does not create a financial lock: only approved/paid payroll runs are locked.

begin;

create extension if not exists pgcrypto;

create table if not exists public.workforce_payout_review_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  subject_type text not null,
  subject_id uuid not null,
  location_id uuid not null references public.stations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  status text not null default 'under_review',
  calculation_snapshot jsonb not null default '{}'::jsonb,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_payout_review_subject_type_check
    check (subject_type in ('workforce', 'helper')),
  constraint workforce_payout_review_period_check
    check (period_end >= period_start),
  constraint workforce_payout_review_status_check
    check (status in ('under_review', 'returned', 'approved', 'cancelled')),
  constraint workforce_payout_review_snapshot_object_check
    check (jsonb_typeof(calculation_snapshot) = 'object'),
  constraint workforce_payout_review_identity_unique
    unique (company_id, subject_type, subject_id, location_id, period_start, period_end)
);

create index if not exists workforce_payout_review_period_idx
  on public.workforce_payout_review_submissions
  (company_id, subject_type, period_start, period_end, status);

create index if not exists workforce_payout_review_subject_idx
  on public.workforce_payout_review_submissions
  (company_id, subject_type, subject_id, period_start desc, period_end desc);

create unique index if not exists stations_company_id_id_uidx
  on public.stations (company_id, id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workforce_payout_review_submissions'::regclass
      and conname = 'workforce_payout_review_location_company_fk'
  ) then
    alter table public.workforce_payout_review_submissions
      add constraint workforce_payout_review_location_company_fk
      foreign key (company_id, location_id)
      references public.stations (company_id, id)
      on delete restrict;
  end if;
end
$$;

comment on table public.workforce_payout_review_submissions is
  'Exact-period payout selections submitted for later review. calculation_snapshot contains server-created metadata only; Under Review remains editable and does not create an approved/paid financial lock.';

alter table public.workforce_payout_review_submissions enable row level security;
alter table public.workforce_payout_review_submissions force row level security;
revoke all on table public.workforce_payout_review_submissions from public, anon, authenticated, service_role;
grant select, insert, update on table public.workforce_payout_review_submissions to service_role;

create or replace function public.guard_workforce_payout_review_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
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

create trigger workforce_payout_review_submissions_00_status_guard
before update of status on public.workforce_payout_review_submissions
for each row execute function public.guard_workforce_payout_review_status_transition();

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
security invoker
set search_path to ''
as $function$
declare
  item jsonb;
  item_type text;
  item_subject uuid;
  item_location uuid;
  item_expected_status text;
  item_metadata constant jsonb := jsonb_build_object(
    'source', 'workforce_payouts',
    'schema_version', 1,
    'amounts_included', false
  );
  saved integer := 0;
  changed integer := 0;
begin
  if p_company is null or p_actor is null then
    raise exception 'Company and submitter are required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'A valid payout period is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one payout';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Submit at most 1000 payouts at a time';
  end if;
  if exists (
    select 1
    from (
      select
        lower(btrim(value ->> 'subject_type')) as subject_type,
        lower(nullif(value ->> 'subject_id', '')) as subject_id,
        lower(nullif(value ->> 'location_id', '')) as location_id
      from jsonb_array_elements(p_items)
    ) normalized
    group by normalized.subject_type, normalized.subject_id, normalized.location_id
    having count(*) > 1
  ) then
    raise exception 'A payout subject was selected more than once';
  end if;

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_type := lower(btrim(item ->> 'subject_type'));
    item_subject := nullif(item ->> 'subject_id', '')::uuid;
    item_location := nullif(item ->> 'location_id', '')::uuid;
    item_expected_status := lower(btrim(item ->> 'expected_status'));

    if item_type is null or item_type not in ('workforce', 'helper') or item_subject is null or item_location is null
      or item_expected_status is null or item_expected_status not in ('ready', 'returned')
    then
      raise exception 'A selected payout has an invalid subject';
    end if;
    if p_locations is not null
      and (item_location is null or not (item_location = any(p_locations)))
    then
      raise exception 'A selected payout is outside your location scope';
    end if;

    if item_type = 'workforce' then
      if not exists (
        select 1
        from public.workforce workforce
        where workforce.company_id = p_company
          and workforce.id = item_subject
          and workforce.deleted_at is null
          and workforce.migration_state <> 'reclassified'
          and (
            exists (
              select 1 from public.field_executive_provider_mappings mapping
              where mapping.company_id = p_company
                and (
                  mapping.workforce_id = workforce.id
                  or (workforce.source_profile_type = 'employee' and mapping.employee_id = workforce.source_profile_id)
                  or (workforce.source_profile_type = 'contractor' and mapping.contractor_id = workforce.source_profile_id)
                  or (workforce.source_profile_type = 'field_executive' and mapping.field_executive_id = workforce.source_profile_id)
                )
                and mapping.station_id = item_location
                and mapping.status <> 'cancelled'
                and mapping.effective_from <= p_period_end
                and (mapping.effective_to is null or mapping.effective_to >= p_period_start)
            )
            or exists (
              select 1 from public.workforce_payment_allocations allocation
              where allocation.company_id = p_company
                and allocation.workforce_id = workforce.id
                and allocation.station_id = item_location
                and allocation.status <> 'cancelled'
                and allocation.effective_from <= p_period_end
                and (allocation.effective_to is null or allocation.effective_to >= p_period_start)
            )
            or exists (
              select 1 from public.workforce_additional_payment_values additional
              where additional.company_id = p_company
                and additional.workforce_id = workforce.id
                and additional.station_id = item_location
                and additional.effective_from = p_period_start
                and additional.effective_to = p_period_end
            )
          )
      ) then
        raise exception 'A selected Workforce payout is unavailable for this company and location';
      end if;
    else
      if not exists (
        select 1
        from public.helpers helper
        where helper.company_id = p_company
          and helper.id = item_subject
          and exists (
              select 1 from public.helper_payment_allocations allocation
              where allocation.company_id = p_company
                and allocation.helper_id = helper.id
                and allocation.station_id = item_location
                and allocation.status <> 'cancelled'
                and allocation.effective_from <= p_period_end
                and (allocation.effective_to is null or allocation.effective_to >= p_period_start)
            )
      ) then
        raise exception 'A selected Helper payout is unavailable for this company and location';
      end if;
    end if;

    if exists (
      select 1
      from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = item_type
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
        and existing.status in ('approved', 'cancelled')
    ) then
      raise exception 'An approved or cancelled payout review cannot be reopened.';
    end if;

    if item_expected_status = 'ready' and exists (
      select 1
      from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = item_type
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
    ) then
      raise exception 'The payout review state changed. Refresh the worksheet and try again.';
    end if;
    if item_expected_status = 'returned' and not exists (
      select 1
      from public.workforce_payout_review_submissions existing
      where existing.company_id = p_company
        and existing.subject_type = item_type
        and existing.subject_id = item_subject
        and existing.location_id = item_location
        and existing.period_start = p_period_start
        and existing.period_end = p_period_end
        and existing.status = 'returned'
    ) then
      raise exception 'The payout review state changed. Refresh the worksheet and try again.';
    end if;

    insert into public.workforce_payout_review_submissions (
      company_id,
      subject_type,
      subject_id,
      location_id,
      period_start,
      period_end,
      status,
      calculation_snapshot,
      submitted_by,
      submitted_at,
      updated_at
    ) select
      p_company,
      item_type,
      item_subject,
      item_location,
      p_period_start,
      p_period_end,
      'under_review',
      item_metadata,
      p_actor,
      now(),
      now()
    where item_expected_status = 'ready'
      or exists (
        select 1
        from public.workforce_payout_review_submissions existing
        where existing.company_id = p_company
          and existing.subject_type = item_type
          and existing.subject_id = item_subject
          and existing.location_id = item_location
          and existing.period_start = p_period_start
          and existing.period_end = p_period_end
          and existing.status = 'returned'
      )
    on conflict (company_id, subject_type, subject_id, location_id, period_start, period_end)
    do update set
      status = 'under_review',
      calculation_snapshot = excluded.calculation_snapshot,
      submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at,
      updated_at = now()
    where item_expected_status = 'returned'
      and workforce_payout_review_submissions.status = 'returned';

    get diagnostics changed = row_count;
    if changed <> 1 then
      raise exception 'The payout review state changed. Refresh the worksheet and try again.';
    end if;

    saved := saved + 1;
  end loop;

  return saved;
end
$function$;

comment on function public.workforce_send_payouts_for_review(uuid, uuid, date, date, jsonb, uuid[]) is
  'Atomically validates unique, location-scoped Workforce/Helper payout selections and their signed expected review state, then stores server-created metadata only. Under Review is non-locking.';

revoke all on function public.guard_workforce_payout_review_status_transition()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_send_payouts_for_review(uuid, uuid, date, date, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.workforce_send_payouts_for_review(uuid, uuid, date, date, jsonb, uuid[])
  to service_role;

notify pgrst, 'reload schema';

commit;
