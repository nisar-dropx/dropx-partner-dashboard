begin;

-- Recovery imports deliberately stop before choosing a recovery route.  The
-- route is a financial decision and is therefore recorded separately, with
-- the exact payout month and actor that made the decision.
alter table public.payment_recovery_cases
  alter column recovery_method drop not null,
  add column payout_month date,
  add column configured_at timestamptz,
  add column configured_by uuid references auth.users(id) on delete set null;

alter table public.payment_recovery_cases
  drop constraint payment_recovery_cases_recovery_method_check,
  add constraint payment_recovery_cases_recovery_method_check
    check (
      recovery_method is null
      or recovery_method in ('payout_deduction', 'post_invoice_dispute')
    ),
  drop constraint payment_recovery_cases_status_check,
  add constraint payment_recovery_cases_status_check
    check (status in (
      'awaiting_configuration',
      'awaiting_registration',
      'ready_for_deduction',
      'partially_recovered',
      'recovered',
      'planned_provider_dispute',
      'under_provider_dispute',
      'provider_credited',
      'dispute_rejected',
      'reversed'
    ));

-- Existing cases were configured by the original import flow. Preserve them
-- as-is and annotate the historical decision instead of rewriting history.
update public.payment_recovery_cases
set payout_month = case
      when recovery_method = 'payout_deduction' then debit_month
      else null
    end,
    configured_at = coalesce(updated_at, created_at),
    configured_by = coalesce(updated_by, created_by)
where recovery_method is not null;

alter table public.payment_recovery_cases
  add constraint payment_recovery_cases_configuration_shape_check
  check (
    (
      recovery_method is null
      and status = 'awaiting_configuration'
      and payout_month is null
      and configured_at is null
      and configured_by is null
    )
    or
    (
      recovery_method = 'post_invoice_dispute'
      and payout_month is null
      and configured_at is not null
    )
    or
    (
      recovery_method = 'payout_deduction'
      and payout_month is not null
      and payout_month = pg_catalog.date_trunc('month', payout_month)::date
      and configured_at is not null
    )
  );

create index payment_recovery_cases_company_payout_month_idx
  on public.payment_recovery_cases(company_id, payout_month desc, id)
  where payout_month is not null;
create index payment_recovery_cases_configured_by_idx
  on public.payment_recovery_cases(configured_by)
  where configured_by is not null;

comment on column public.payment_recovery_cases.payout_month is
  'Exact payout month selected after import, stored as the first calendar day. NULL for provider disputes and unconfigured cases.';
comment on column public.payment_recovery_cases.configured_at is
  'When the post-upload recovery method was committed.';

alter table public.payment_recovery_allocations
  add column payout_engine text,
  add column payout_run_id uuid,
  add column payout_run_person_id uuid references public.hr_payroll_run_people(id) on delete set null,
  add column deduction_value_id uuid references public.workforce_payout_deduction_values(id) on delete set null,
  add column payroll_manual_entry_id uuid references public.hr_payroll_run_manual_entries(id) on delete set null;

alter table public.payment_recovery_allocations
  add constraint payment_recovery_allocations_payout_engine_check
    check (payout_engine is null or payout_engine in ('workforce', 'people_payroll')),
  add constraint payment_recovery_allocations_people_payroll_run_company_fk
    foreign key (company_id, payout_run_id)
    references public.hr_payroll_runs(company_id, id)
    on delete restrict,
  add constraint payment_recovery_allocations_payout_link_shape_check
    check (
      payout_engine is null
      or (
        payout_engine = 'workforce'
        and workforce_id is not null
        and payout_run_id is null
        and payroll_manual_entry_id is null
      )
      or (
        payout_engine = 'people_payroll'
        and target_type in ('employee', 'contractor')
        and payout_run_id is not null
        and deduction_value_id is null
      )
    );

create index payment_recovery_allocations_workforce_deduction_idx
  on public.payment_recovery_allocations(company_id, deduction_value_id)
  where deduction_value_id is not null;
create index payment_recovery_allocations_people_payroll_idx
  on public.payment_recovery_allocations(company_id, payout_run_id, target_type, target_id)
  where payout_engine = 'people_payroll';
create index payment_recovery_allocations_people_run_person_idx
  on public.payment_recovery_allocations(payout_run_person_id)
  where payout_run_person_id is not null;
create index payment_recovery_allocations_manual_entry_idx
  on public.payment_recovery_allocations(payroll_manual_entry_id)
  where payroll_manual_entry_id is not null;

create unique index payment_recovery_events_one_applied_payout_deduction_uidx
  on public.payment_recovery_events(company_id, allocation_id, event_type)
  where allocation_id is not null
    and event_type = 'payout_deduction'
    and status = 'applied';

-- Native People payroll has a single manual exception-debit input. Track the
-- system-owned Recovery portion independently so a later manual upload can
-- replace its own portion without erasing Recovery.
alter table public.hr_payroll_run_manual_entries
  add column payment_recovery_amount numeric(18,2) not null default 0,
  add column payment_recovery_note text,
  add constraint hr_payroll_run_manual_entries_payment_recovery_amount_check
    check (payment_recovery_amount >= 0);

create or replace function public.preserve_hr_payment_recovery_manual_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.payment_recovery_amount is not distinct from old.payment_recovery_amount
      and new.exception_debit is distinct from old.exception_debit
    then
      -- Existing upload/UI contracts submit only the manual exception debit.
      -- Add the protected Recovery component back before constraints/calculation.
      new.exception_debit := coalesce(new.exception_debit, 0) + old.payment_recovery_amount;
    elsif new.payment_recovery_amount is distinct from old.payment_recovery_amount
      and coalesce(new.exception_debit, 0) < new.payment_recovery_amount
    then
      raise exception 'The payroll exception debit cannot be lower than its payment Recovery component.';
    end if;

    if new.payment_recovery_amount is not distinct from old.payment_recovery_amount
      and old.payment_recovery_amount > 0
      and new.exception_debit_reason is distinct from old.exception_debit_reason
      and nullif(pg_catalog.btrim(old.payment_recovery_note), '') is not null
      and pg_catalog.strpos(
        coalesce(new.exception_debit_reason, ''),
        old.payment_recovery_note
      ) = 0
    then
      new.exception_debit_reason := pg_catalog.concat_ws(
        '; ',
        nullif(pg_catalog.btrim(new.exception_debit_reason), ''),
        old.payment_recovery_note
      );
    end if;
  elsif new.payment_recovery_amount > 0
    and coalesce(new.exception_debit, 0) < new.payment_recovery_amount
  then
    raise exception 'The payroll exception debit cannot be lower than its payment Recovery component.';
  end if;
  return new;
end;
$function$;

create trigger hr_payroll_run_manual_entries_00_preserve_payment_recovery
before insert or update on public.hr_payroll_run_manual_entries
for each row execute function public.preserve_hr_payment_recovery_manual_entry();

-- A distinct calculated item keeps the immediate payroll snapshot readable.
-- On a later full calculation the same amount is retained by exception_debit.
create unique index hr_payroll_run_items_payment_recovery_uidx
  on public.hr_payroll_run_items(company_id, run_person_id, code, source)
  where code = 'RECOVERY' and source = 'payment_recovery';

-- RECOVERY is a system-owned Workforce deduction head. Preserve any legacy
-- manual head that happened to use this code before reserving it.
do $migrate_legacy_recovery_heads$
declare
  v_head record;
  v_legacy_code text;
begin
  for v_head in
    select head.id, head.company_id
    from public.workforce_deduction_heads head
    where pg_catalog.upper(pg_catalog.btrim(head.code)) = 'RECOVERY'
      and (
        head.is_system is distinct from true
        or exists (
          select 1
          from public.workforce_payout_deduction_values value
          where value.company_id = head.company_id
            and value.deduction_head_id = head.id
            and value.source_type <> 'payment_recovery'
        )
      )
  loop
    v_legacy_code := 'LEGACY_RECOVERY_' || pg_catalog.upper(
      pg_catalog.substr(pg_catalog.replace(v_head.id::text, '-', ''), 1, 8)
    );
    update public.workforce_deduction_heads
    set code = v_legacy_code,
        name = 'Legacy Recovery',
        description = 'Manual deductions retained from before the Payment Recovery register.',
        is_system = false,
        updated_at = pg_catalog.clock_timestamp()
    where id = v_head.id and company_id = v_head.company_id;
  end loop;
end;
$migrate_legacy_recovery_heads$;

insert into public.workforce_deduction_heads(
  company_id, code, name, description, calculation_type, default_value,
  percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
)
select company.id, 'RECOVERY', 'Recovery',
       'Payout recovery controlled by the Payment Recovery register.',
       'manual', 0, 0, '{}'::text[], false, true, true
from public.companies company
on conflict (company_id, code) do update set
  name = excluded.name,
  description = excluded.description,
  calculation_type = 'manual',
  applies_to_all = false,
  is_system = true,
  is_active = true,
  updated_at = pg_catalog.clock_timestamp();

create or replace function public.seed_payment_recovery_deduction_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.workforce_deduction_heads(
    company_id, code, name, description, calculation_type, default_value,
    percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
  ) values (
    new.id, 'RECOVERY', 'Recovery',
    'Payout recovery controlled by the Payment Recovery register.',
    'manual', 0, 0, '{}'::text[], false, true, true
  ) on conflict (company_id, code) do nothing;
  return new;
end;
$function$;

create trigger companies_seed_payment_recovery_deduction_head
after insert on public.companies
for each row execute function public.seed_payment_recovery_deduction_head();

-- Close the installation window between the initial backfill and trigger
-- creation: a company committed during that window is now seeded as well.
insert into public.workforce_deduction_heads(
  company_id, code, name, description, calculation_type, default_value,
  percentage_without_pan, workforce_category_codes, applies_to_all, is_system, is_active
)
select company.id, 'RECOVERY', 'Recovery',
       'Payout recovery controlled by the Payment Recovery register.',
       'manual', 0, 0, '{}'::text[], false, true, true
from public.companies company
on conflict (company_id, code) do nothing;

create or replace function public.guard_payment_recovery_deduction_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.upper(pg_catalog.btrim(old.code)) <> 'RECOVERY' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'RECOVERY is managed by the Payment Recovery register and cannot be deleted.';
  end if;
  if pg_catalog.upper(pg_catalog.btrim(new.code)) <> 'RECOVERY'
    or new.calculation_type <> 'manual'
    or new.is_system is distinct from true
    or new.is_active is distinct from true
  then
    raise exception 'RECOVERY is managed by the Payment Recovery register and cannot be changed.';
  end if;
  return new;
end;
$function$;

create trigger workforce_deduction_heads_01_recovery_guard
before update or delete on public.workforce_deduction_heads
for each row execute function public.guard_payment_recovery_deduction_head();

alter table public.workforce_payout_deduction_values
  drop constraint workforce_payout_deduction_values_source_check,
  drop constraint workforce_payout_deduction_values_source_shape_check;

alter table public.workforce_payout_deduction_values
  add constraint workforce_payout_deduction_values_source_check
    check (source_type in ('bulk_import', 'advance_register', 'payment_recovery')),
  add constraint workforce_payout_deduction_values_source_shape_check
    check (
      (source_type = 'bulk_import' and source_batch_id is not null and source_row_id is not null)
      or
      (source_type in ('advance_register', 'payment_recovery') and source_batch_id is null and source_row_id is null)
    );

create or replace function public.prepare_workforce_payout_deduction_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_head public.workforce_deduction_heads%rowtype;
begin
  new.source_type := coalesce(nullif(new.source_type, ''), 'bulk_import');

  select head.*
  into v_head
  from public.workforce_deduction_heads head
  where head.company_id = new.company_id
    and head.id = new.deduction_head_id
    and head.is_active = true
    and head.calculation_type = 'manual'
    and (
      (new.source_type = 'advance_register' and head.is_system and pg_catalog.upper(pg_catalog.btrim(head.code)) = 'ADVANCE')
      or
      (new.source_type = 'payment_recovery' and head.is_system and pg_catalog.upper(pg_catalog.btrim(head.code)) = 'RECOVERY')
      or
      (new.source_type = 'bulk_import' and head.is_system is false)
    );

  if not found then
    raise exception 'Deduction head is not valid for this payout input source.';
  end if;
  if new.effective_from is null or new.effective_to is null or new.effective_to < new.effective_from then
    raise exception 'A valid deduction period is required.';
  end if;
  if new.amount is null or new.amount < 0 then
    raise exception 'Deduction amount must be zero or greater.';
  end if;
  if new.station_id is null or not exists (
    select 1 from public.stations station
    where station.company_id = new.company_id and station.id = new.station_id
  ) then
    raise exception 'Deduction location must belong to this company.';
  end if;
  if not public.workforce_additional_payment_location_is_authorized(
    new.company_id, new.workforce_id, new.station_id,
    new.effective_from, new.effective_to
  ) then
    raise exception 'Deduction location must be the Workforce current location or an overlapping historical payment location.';
  end if;

  new.head_code_snapshot := v_head.code;
  new.head_name_snapshot := v_head.name;
  new.import_metadata := coalesce(new.import_metadata, '{}'::jsonb);
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

-- Both system heads are register-controlled and cannot be introduced through
-- the general payout-input workbook.
create or replace function public.guard_workforce_advance_payout_import_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text;
begin
  if new.input_type = 'DEDUCTION' and new.deduction_head_id is not null then
    select pg_catalog.upper(pg_catalog.btrim(head.code))
    into v_code
    from public.workforce_deduction_heads head
    where head.company_id = new.company_id and head.id = new.deduction_head_id;

    if v_code in ('ADVANCE', 'RECOVERY') then
      raise exception '% is system-managed and cannot be bulk uploaded or cleared as a manual deduction.', v_code;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.payment_recovery_eligible_payout_targets(
  p_company_id uuid,
  p_payout_month date,
  p_allowed_location_ids uuid[] default null
)
returns table (
  dropx_id text,
  person_name text,
  target_type text,
  target_id uuid,
  workforce_id uuid,
  payout_engine text,
  payout_run_id uuid,
  payout_run_person_id uuid,
  station_id uuid,
  location_code text,
  payout_status text,
  is_editable boolean,
  lock_reason text,
  available_amount numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  with period as (
    select
      p_payout_month period_start,
      (p_payout_month + interval '1 month - 1 day')::date period_end
    where p_company_id is not null
      and p_payout_month is not null
      and p_payout_month = pg_catalog.date_trunc('month', p_payout_month)::date
  ),
  people_payroll_base as (
    select
      public.normalize_people_dropx_id(
        case when payroll_person.worker_type = 'employee'
          then employee.employee_code else contractor.dropx_id end
      ) dropx_id,
      coalesce(
        nullif(pg_catalog.btrim(payroll_person.worker_name), ''),
        nullif(pg_catalog.btrim(employee.full_name), ''),
        nullif(pg_catalog.btrim(contractor.full_name), ''),
        'Registered person'
      ) person_name,
      payroll_person.worker_type target_type,
      payroll_person.worker_id target_id,
      canonical.id workforce_id,
      payroll_run.id payout_run_id,
      payroll_person.id payout_run_person_id,
      payroll_person.location_id station_id,
      station.station_code location_code,
      payroll_run.status,
      payroll_run.published_at,
      payroll_person.calculation_status,
      greatest(
        coalesce(
          case
            when payroll_person.is_adjusted and payroll_person.adjusted_net_pay is not null
              then payroll_person.adjusted_net_pay
            else payroll_person.net_pay
          end,
          0
        ),
        0
      )::numeric available_amount,
      station.is_active station_is_active
    from period
    join public.hr_payroll_runs payroll_run
      on payroll_run.company_id = p_company_id
     and payroll_run.period_start = period.period_start
     and payroll_run.period_end = period.period_end
    join public.hr_payroll_run_people payroll_person
      on payroll_person.company_id = payroll_run.company_id
     and payroll_person.run_id = payroll_run.id
     and payroll_person.worker_type in ('employee', 'contractor')
    left join public.employees employee
      on payroll_person.worker_type = 'employee'
     and employee.company_id = payroll_person.company_id
     and employee.id = payroll_person.worker_id
    left join public.contractors contractor
      on payroll_person.worker_type = 'contractor'
     and contractor.company_id = payroll_person.company_id
     and contractor.id = payroll_person.worker_id
    left join public.workforce canonical
      on canonical.company_id = payroll_person.company_id
     and canonical.source_profile_type = payroll_person.worker_type
     and canonical.source_profile_id = payroll_person.worker_id
     and canonical.is_active is true
     and canonical.deleted_at is null
     and coalesce(canonical.migration_state, 'canonical') not in ('reclassified', 'moved_to_vendor')
    left join public.stations station
      on station.company_id = payroll_person.company_id
     and station.id = payroll_person.location_id
    where public.normalize_people_dropx_id(
      case when payroll_person.worker_type = 'employee'
        then employee.employee_code else contractor.dropx_id end
    ) is not null
  ),
  people_payroll as (
    select people_payroll_base.*,
           pg_catalog.count(*) over (partition by people_payroll_base.dropx_id) identity_count
    from people_payroll_base
  ),
  workforce_sources as (
    select allocation.workforce_id, allocation.station_id
    from period
    join public.workforce_payment_allocations allocation
      on allocation.company_id = p_company_id
     and allocation.status in ('active', 'closed')
     and allocation.payment_method_id is not null
     and allocation.effective_from <= period.period_end
     and coalesce(allocation.effective_to, period.period_end) >= period.period_start
    where allocation.station_id is not null

    union

    select workforce.id, mapping.station_id
    from period
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = p_company_id
     and mapping.status in ('active', 'closed')
     and mapping.payment_method_id is not null
     and mapping.effective_from <= period.period_end
     and coalesce(mapping.effective_to, period.period_end) >= period.period_start
    join public.workforce workforce
      on workforce.company_id = mapping.company_id
     and (
       mapping.workforce_id = workforce.id
       or mapping.field_executive_id = workforce.id
       or (
         mapping.employee_id is not null
         and workforce.source_profile_type = 'employee'
         and workforce.source_profile_id = mapping.employee_id
       )
       or (
         mapping.contractor_id is not null
         and workforce.source_profile_type = 'contractor'
         and workforce.source_profile_id = mapping.contractor_id
       )
       or (
         mapping.field_executive_id is not null
         and workforce.source_profile_type = 'field_executive'
         and workforce.source_profile_id = mapping.field_executive_id
       )
     )
    where mapping.station_id is not null
  ),
  workforce_candidates as (
    select distinct
      source.workforce_id,
      source.station_id,
      public.normalize_people_dropx_id(workforce.dropx_id) dropx_id,
      coalesce(nullif(pg_catalog.btrim(workforce.full_name), ''), 'Registered person') person_name,
      case
        when workforce.source_profile_type in ('employee', 'contractor')
          and workforce.source_profile_id is not null
          then workforce.source_profile_type
        else 'workforce'
      end target_type,
      case
        when workforce.source_profile_type in ('employee', 'contractor')
          and workforce.source_profile_id is not null
          then workforce.source_profile_id
        else workforce.id
      end target_id,
      station.station_code location_code,
      station.is_active station_is_active,
      pg_catalog.count(*) over (partition by source.workforce_id) station_count
    from workforce_sources source
    join public.workforce workforce
      on workforce.company_id = p_company_id
     and workforce.id = source.workforce_id
     and workforce.deleted_at is null
     and coalesce(workforce.migration_state, 'canonical') not in ('reclassified', 'moved_to_vendor')
    left join public.stations station
      on station.company_id = p_company_id and station.id = source.station_id
    where public.normalize_people_dropx_id(workforce.dropx_id) is not null
  ),
  workforce_state as (
    select candidate.*,
      exists (
        select 1
        from period
        join public.workforce_payout_publications publication
          on publication.company_id = p_company_id
         and publication.workforce_id = candidate.workforce_id
         and publication.station_id = candidate.station_id
        left join public.workforce_payroll_runs publication_run
          on publication_run.company_id = publication.company_id
         and publication_run.id = publication.payroll_run_id
        where (
          publication.period_start = period.period_start
          and publication.period_end = period.period_end
        ) or (
          publication.period_start is null
          and publication.period_end is null
          and publication_run.period_start = period.period_start
          and publication_run.period_end = period.period_end
        )
      ) is_published,
      exists (
        select 1
        from period
        join public.workforce_payout_review_submissions review
          on review.company_id = p_company_id
         and review.subject_type = 'workforce'
         and review.subject_id = candidate.workforce_id
         and review.location_id = candidate.station_id
         and review.period_start = period.period_start
         and review.period_end = period.period_end
         and review.status in ('under_review', 'approved')
      ) is_under_review,
      exists (
        select 1
        from period
        join public.workforce_payroll_runs payroll_run
          on payroll_run.company_id = p_company_id
         and payroll_run.period_start <= period.period_end
         and payroll_run.period_end >= period.period_start
         and (payroll_run.station_id is null or payroll_run.station_id = candidate.station_id)
         and pg_catalog.lower(coalesce(payroll_run.status, '')) in ('review', 'approved', 'paid')
      ) is_processed
    from workforce_candidates candidate
  )
  select
    people.dropx_id,
    people.person_name,
    people.target_type,
    people.target_id,
    people.workforce_id,
    'people_payroll'::text payout_engine,
    people.payout_run_id,
    people.payout_run_person_id,
    people.station_id,
    people.location_code,
    ('people_payroll:' || people.status)::text payout_status,
    (
      people.identity_count = 1
      and people.published_at is null
      and people.status in ('draft', 'calculated')
      and people.calculation_status = 'ready'
      and people.available_amount > 0
      and people.station_id is not null
      and (p_allowed_location_ids is null or people.station_id = any(p_allowed_location_ids))
    ) is_editable,
    case
      when people.identity_count <> 1 then 'This DropX ID matches more than one People payroll row.'
      when people.published_at is not null then 'This People payroll was published and is locked.'
      when people.status not in ('draft', 'calculated') then 'This People payroll is already reviewed, approved or locked.'
      when people.calculation_status <> 'ready' then 'This People payroll calculation is not ready.'
      when people.available_amount <= 0 then 'This People payroll has no available amount for Recovery.'
      when people.station_id is null then 'This People payroll has no payment location.'
      when p_allowed_location_ids is not null and not (people.station_id = any(p_allowed_location_ids)) then 'This payout is outside your location access.'
      else null
    end lock_reason,
    people.available_amount
  from people_payroll people
  where p_allowed_location_ids is null
     or people.station_id = any(p_allowed_location_ids)

  union all

  select
    workforce.dropx_id,
    workforce.person_name,
    workforce.target_type,
    workforce.target_id,
    workforce.workforce_id,
    'workforce'::text payout_engine,
    null::uuid payout_run_id,
    null::uuid payout_run_person_id,
    workforce.station_id,
    workforce.location_code,
    case
      when workforce.is_published then 'workforce:published'
      when workforce.is_under_review then 'workforce:under_review'
      when workforce.is_processed then 'workforce:processed'
      else 'workforce:open'
    end payout_status,
    (
      workforce.station_count = 1
      and workforce.station_id is not null
      and not workforce.is_published
      and not workforce.is_under_review
      and not workforce.is_processed
      and (p_allowed_location_ids is null or workforce.station_id = any(p_allowed_location_ids))
    ) is_editable,
    case
      when workforce.station_count <> 1 then 'This DropX ID has more than one payout location in the selected month.'
      when workforce.station_id is null then 'This Workforce payout has no payment location.'
      when workforce.is_published then 'This Workforce payout was published and is locked.'
      when workforce.is_under_review then 'This Workforce payout is under review or approved.'
      when workforce.is_processed then 'This Workforce payroll is already in review, approved or paid.'
      when p_allowed_location_ids is not null and not (workforce.station_id = any(p_allowed_location_ids)) then 'This payout is outside your location access.'
      else null
    end lock_reason,
    null::numeric available_amount
  from workforce_state workforce
  where (p_allowed_location_ids is null
      or workforce.station_id = any(p_allowed_location_ids))
    and not exists (
    select 1 from people_payroll people
    where people.dropx_id = workforce.dropx_id
  )

  order by dropx_id, payout_engine, location_code
$function$;

comment on function public.payment_recovery_eligible_payout_targets(uuid, date, uuid[]) is
  'Returns exact-month Recovery targets from native People payroll or Workforce payout setup, including lock reasons. Native People payroll takes precedence for employees and contractors.';

revoke all on function public.payment_recovery_eligible_payout_targets(uuid, date, uuid[])
  from public, anon, authenticated;
grant execute on function public.payment_recovery_eligible_payout_targets(uuid, date, uuid[])
  to service_role;

create or replace function public.payment_recovery_available_payout_months(
  p_company_id uuid,
  p_allowed_location_ids uuid[] default null
)
returns table (
  payout_month date,
  target_count bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with bounds as (
    select
      (pg_catalog.date_trunc('month', current_date) - interval '120 months')::date first_month,
      pg_catalog.date_trunc('month', current_date)::date last_month
  ), configured_months as (
    select payroll_run.period_start payout_month
    from public.hr_payroll_runs payroll_run
    join bounds on true
    where payroll_run.company_id = p_company_id
      and payroll_run.period_start = pg_catalog.date_trunc('month', payroll_run.period_start)::date
      and payroll_run.period_start between bounds.first_month and bounds.last_month
      and exists (
        select 1
        from public.hr_payroll_run_people payroll_person
        where payroll_person.company_id = p_company_id
          and payroll_person.run_id = payroll_run.id
          and payroll_person.worker_type in ('employee', 'contractor')
          and (
            p_allowed_location_ids is null
            or payroll_person.location_id = any(p_allowed_location_ids)
          )
      )

    union

    select month_value::date
    from bounds
    join public.workforce_payment_allocations allocation
      on allocation.company_id = p_company_id
     and allocation.status in ('active', 'closed')
     and allocation.payment_method_id is not null
     and allocation.station_id is not null
     and (p_allowed_location_ids is null or allocation.station_id = any(p_allowed_location_ids))
    cross join lateral pg_catalog.generate_series(
      greatest(pg_catalog.date_trunc('month', allocation.effective_from)::date, bounds.first_month),
      least(
        pg_catalog.date_trunc('month', coalesce(allocation.effective_to, bounds.last_month))::date,
        bounds.last_month
      ),
      interval '1 month'
    ) month_value

    union

    select month_value::date
    from bounds
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = p_company_id
     and mapping.status in ('active', 'closed')
     and mapping.payment_method_id is not null
     and mapping.station_id is not null
     and (p_allowed_location_ids is null or mapping.station_id = any(p_allowed_location_ids))
    cross join lateral pg_catalog.generate_series(
      greatest(pg_catalog.date_trunc('month', mapping.effective_from)::date, bounds.first_month),
      least(
        pg_catalog.date_trunc('month', coalesce(mapping.effective_to, bounds.last_month))::date,
        bounds.last_month
      ),
      interval '1 month'
    ) month_value
  )
  select configured.payout_month, pg_catalog.count(target.dropx_id)::bigint target_count
  from configured_months configured
  cross join lateral public.payment_recovery_eligible_payout_targets(
    p_company_id,
    configured.payout_month,
    p_allowed_location_ids
  ) target
  group by configured.payout_month
  having pg_catalog.count(target.dropx_id) > 0
  order by configured.payout_month desc
$function$;

comment on function public.payment_recovery_available_payout_months(uuid, uuid[]) is
  'Returns only scope-authorized payroll months that have actual People or Workforce payout targets for Recovery configuration.';

revoke all on function public.payment_recovery_available_payout_months(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.payment_recovery_available_payout_months(uuid, uuid[])
  to service_role;

create or replace function public.payment_recovery_apply_import(
  p_company_id uuid,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing_batch_id uuid;
  v_batch_id uuid;
  v_row jsonb;
  v_row_number integer;
  v_tid text;
  v_normalized_tid text;
  v_location_code text;
  v_debit_month date;
  v_debit_amount numeric(18,2);
  v_provider public.providers%rowtype;
  v_station public.stations%rowtype;
  v_location_match_count integer;
  v_provider_match_count integer;
  v_inserted_cases integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and actor are required.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid workbook fingerprint is required.';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) = 0
  then
    raise exception 'The recovery workbook does not contain any rows.';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 10000 then
    raise exception 'A recovery workbook can contain at most 10000 TIDs.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':payment-recovery-import', 0)
  );

  select batch.id into v_existing_batch_id
  from public.payment_recovery_import_batches batch
  where batch.company_id = p_company_id and batch.file_sha256 = p_file_sha256;
  if found then
    return pg_catalog.jsonb_build_object(
      'batch_id', v_existing_batch_id,
      'replayed', true,
      'cases', 0,
      'allocations', 0
    );
  end if;

  for v_normalized_tid in
    select distinct public.normalize_payment_recovery_tid(row_data.value->>'tid')
    from pg_catalog.jsonb_array_elements(p_rows) row_data
    order by 1
  loop
    if v_normalized_tid is null then
      raise exception 'Every recovery row requires a TID.';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_company_id::text || ':payment-recovery-tid:' || v_normalized_tid,
        0
      )
    );
    if exists (
      select 1 from public.payment_recovery_cases recovery
      where recovery.company_id = p_company_id
        and public.normalize_payment_recovery_tid(recovery.tid) = v_normalized_tid
    ) then
      raise exception 'TID % is already in the Recovery register.', v_normalized_tid;
    end if;
  end loop;

  insert into public.payment_recovery_import_batches(
    company_id, file_name, file_sha256, row_count, created_by
  ) values (
    p_company_id,
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(p_file_name), ''), 'payment-recoveries.xlsx'),
      240
    ),
    p_file_sha256,
    pg_catalog.jsonb_array_length(p_rows),
    p_actor_user_id
  ) returning id into v_batch_id;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_rows)
  loop
    begin
      v_row_number := nullif(v_row->>'row_number', '')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every recovery row requires its workbook row number.';
    end;
    v_tid := nullif(pg_catalog.btrim(v_row->>'tid'), '');
    v_normalized_tid := public.normalize_payment_recovery_tid(v_tid);
    v_location_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_row->>'location', '')));
    begin
      v_debit_month := coalesce(
        nullif(pg_catalog.btrim(v_row->>'debit_month'), '')::date,
        pg_catalog.date_trunc(
          'month', nullif(pg_catalog.btrim(v_row->>'debit_date'), '')::date
        )::date
      );
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Row % requires a valid debit month.', v_row_number;
    end;
    begin
      v_debit_amount := pg_catalog.round(
        coalesce(
          nullif(v_row->>'debit_amount', '')::numeric,
          nullif(v_row->>'value', '')::numeric,
          0
        ),
        2
      );
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Row % requires a valid value.', v_row_number;
    end;

    if v_row_number is null or v_row_number < 2 then
      raise exception 'Every recovery row requires its workbook row number.';
    end if;
    if v_normalized_tid is null or pg_catalog.char_length(v_tid) > 120 then
      raise exception 'Row % has an invalid TID.', v_row_number;
    end if;
    if v_location_code = '' then
      raise exception 'Row % requires a location.', v_row_number;
    end if;
    if v_debit_month is null
      or v_debit_month is distinct from pg_catalog.date_trunc('month', v_debit_month)::date
    then
      raise exception 'Row % debit month must be the first day of its month.', v_row_number;
    end if;
    if v_debit_amount <= 0 then
      raise exception 'Row % requires a value greater than zero.', v_row_number;
    end if;

    select pg_catalog.count(*)::integer into v_location_match_count
    from public.stations station
    where station.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(station.station_code)) = v_location_code;
    if v_location_match_count = 0 then
      raise exception 'Row % location % was not found.', v_row_number, v_location_code;
    end if;
    if v_location_match_count > 1 then
      raise exception 'Row % location % matches more than one location. Fix the location master before importing.',
        v_row_number, v_location_code;
    end if;

    select station.* into v_station
    from public.stations station
    where station.company_id = p_company_id
      and pg_catalog.upper(pg_catalog.btrim(station.station_code)) = v_location_code
    order by station.id
    limit 1;

    if v_station.provider_id is null then
      raise exception 'Row % location % is not linked to a provider.', v_row_number, v_location_code;
    end if;
    if p_allowed_location_ids is not null and not (v_station.id = any(p_allowed_location_ids)) then
      raise exception 'Row % location % is outside your access scope.', v_row_number, v_location_code;
    end if;

    select pg_catalog.count(*)::integer into v_provider_match_count
    from public.providers provider
    where provider.company_id = p_company_id and provider.id = v_station.provider_id;
    if v_provider_match_count <> 1 then
      raise exception 'Row % location % has an invalid or ambiguous provider mapping.',
        v_row_number, v_location_code;
    end if;

    select provider.* into v_provider
    from public.providers provider
    where provider.company_id = p_company_id and provider.id = v_station.provider_id
    order by provider.id
    limit 1;
    if nullif(pg_catalog.btrim(v_provider.code), '') is null then
      raise exception 'Row % location % is linked to a provider without a code.',
        v_row_number, v_location_code;
    end if;

    insert into public.payment_recovery_cases(
      company_id, tid, provider_id, station_id, debit_date, debit_month,
      debit_amount, recovery_method, status,
      provider_code_snapshot, provider_name_snapshot, station_code_snapshot,
      provider_reference, reason, remark,
      source_type, source_batch_id, source_row_number, created_by, updated_by
    ) values (
      p_company_id, v_tid, v_provider.id, v_station.id, v_debit_month, v_debit_month,
      v_debit_amount, null, 'awaiting_configuration',
      v_provider.code,
      coalesce(nullif(pg_catalog.btrim(v_provider.name), ''), v_provider.code),
      coalesce(v_station.station_code, v_location_code),
      nullif(pg_catalog.btrim(v_row->>'provider_reference'), ''),
      nullif(pg_catalog.btrim(v_row->>'reason'), ''),
      nullif(pg_catalog.btrim(v_row->>'remark'), ''),
      'bulk_import', v_batch_id, v_row_number, p_actor_user_id, p_actor_user_id
    );
    v_inserted_cases := v_inserted_cases + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'batch_id', v_batch_id,
    'replayed', false,
    'cases', v_inserted_cases,
    'allocations', 0
  );
end;
$function$;

comment on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[]) is
  'Atomically imports monthly provider debit cases as awaiting configuration. Provider is inferred from LOCATION; method, payout month and people are selected later.';

revoke all on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.payment_recovery_apply_import(uuid, text, text, jsonb, uuid, uuid[])
  to service_role;

create or replace function public.payment_recovery_configure_case(
  p_company_id uuid,
  p_recovery_case_id uuid,
  p_recovery_method text,
  p_payout_month date default null,
  p_dropx_ids text[] default null,
  p_workforce_items jsonb default '[]'::jsonb,
  p_actor_user_id uuid default null,
  p_allowed_location_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_case public.payment_recovery_cases%rowtype;
  v_method text;
  v_period_end date;
  v_normalized_ids text[] := '{}'::text[];
  v_input_count integer := 0;
  v_distinct_count integer := 0;
  v_dropx_id text;
  v_candidate_count integer;
  v_candidate record;
  v_allocation_id uuid;
  v_allocation_amount numeric(18,2);
  v_total_cents bigint;
  v_base_cents bigint;
  v_remainder bigint;
  v_index integer := 0;
  v_recovery_head_id uuid;
  v_deduction_value_id uuid;
  v_manual_entry_id uuid;
  v_existing_ids text[];
  v_existing_count integer;
  v_expected_snapshot_hash text;
  v_current_snapshot_hash text;
  v_workforce_item jsonb;
  v_workforce_item_count integer;
  v_workforce_items_used integer := 0;
  v_workforce_max_amount numeric(18,2);
  v_existing_deduction_station_id uuid;
  v_existing_deduction_source text;
begin
  if p_company_id is null or p_recovery_case_id is null or p_actor_user_id is null then
    raise exception 'Company, Recovery case and actor are required.';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_workforce_items, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Workforce payout availability must be an array.';
  end if;

  v_method := pg_catalog.lower(pg_catalog.btrim(coalesce(p_recovery_method, '')));
  if v_method not in ('payout_deduction', 'post_invoice_dispute') then
    raise exception 'Select payout deduction or post-invoice provider dispute.';
  end if;

  if v_method = 'payout_deduction' then
    if p_payout_month is null
      or p_payout_month is distinct from pg_catalog.date_trunc('month', p_payout_month)::date
    then
      raise exception 'Payout month must be the first day of the selected month.';
    end if;

    select
      pg_catalog.count(*)::integer,
      pg_catalog.count(distinct public.normalize_people_dropx_id(input.dropx_id))::integer,
      pg_catalog.array_agg(
        public.normalize_people_dropx_id(input.dropx_id)
        order by public.normalize_people_dropx_id(input.dropx_id)
      )
    into v_input_count, v_distinct_count, v_normalized_ids
    from pg_catalog.unnest(coalesce(p_dropx_ids, '{}'::text[])) input(dropx_id)
    where public.normalize_people_dropx_id(input.dropx_id) is not null;

    if v_input_count < 1 or v_input_count > 50 then
      raise exception 'Select between 1 and 50 DropX IDs for payout deduction.';
    end if;
    if v_input_count <> pg_catalog.cardinality(coalesce(p_dropx_ids, '{}'::text[])) then
      raise exception 'Every selected Recovery ID must be a valid DropX ID.';
    end if;
    if v_distinct_count <> v_input_count then
      raise exception 'A DropX ID was selected more than once.';
    end if;

    if pg_catalog.jsonb_typeof(coalesce(p_workforce_items, '[]'::jsonb)) is distinct from 'array'
      or pg_catalog.jsonb_array_length(coalesce(p_workforce_items, '[]'::jsonb)) > 50
    then
      raise exception 'Workforce payout availability must be a list of at most 50 selected rows.';
    end if;

    if pg_catalog.jsonb_array_length(coalesce(p_workforce_items, '[]'::jsonb)) > 0 then
      v_expected_snapshot_hash := nullif(
        pg_catalog.btrim(coalesce(p_workforce_items->0->>'snapshot_hash', '')),
        ''
      );
      if v_expected_snapshot_hash is null or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_workforce_items) item
        where nullif(pg_catalog.btrim(item->>'snapshot_hash'), '')
          is distinct from v_expected_snapshot_hash
      ) then
        raise exception 'The Workforce payout calculation snapshot is missing or inconsistent. Refresh and try again.';
      end if;
    end if;
  elsif p_payout_month is not null
    or pg_catalog.cardinality(coalesce(p_dropx_ids, '{}'::text[])) <> 0
    or pg_catalog.jsonb_array_length(coalesce(p_workforce_items, '[]'::jsonb)) <> 0
  then
    raise exception 'Post-invoice provider dispute must not include a payout month, DropX IDs or payout availability.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':payment-recovery-configure', 0)
  );

  select recovery.* into v_case
  from public.payment_recovery_cases recovery
  where recovery.company_id = p_company_id and recovery.id = p_recovery_case_id
  for update;
  if not found then
    raise exception 'Recovery case was not found.';
  end if;
  if p_allowed_location_ids is not null and not (v_case.station_id = any(p_allowed_location_ids)) then
    raise exception 'This Recovery case is outside your location access.';
  end if;

  if v_case.recovery_method is not null then
    if v_case.recovery_method <> v_method then
      raise exception 'This Recovery case is already configured with another recovery method.';
    end if;

    if v_method = 'payout_deduction' then
      select
        coalesce(pg_catalog.array_agg(
          public.normalize_people_dropx_id(allocation.imported_dropx_id)
          order by public.normalize_people_dropx_id(allocation.imported_dropx_id)
        ), '{}'::text[]),
        pg_catalog.count(*)::integer
      into v_existing_ids, v_existing_count
      from public.payment_recovery_allocations allocation
      where allocation.company_id = p_company_id
        and allocation.recovery_case_id = p_recovery_case_id;

      if v_case.payout_month is distinct from p_payout_month
        or v_existing_count <> v_input_count
        or v_existing_ids is distinct from v_normalized_ids
      then
        raise exception 'This Recovery case is already configured and cannot be changed.';
      end if;
    elsif p_payout_month is not null
      or pg_catalog.cardinality(coalesce(p_dropx_ids, '{}'::text[])) <> 0
    then
      raise exception 'This Recovery case is already configured and cannot be changed.';
    end if;

    return pg_catalog.jsonb_build_object(
      'case_id', v_case.id,
      'recovery_method', v_case.recovery_method,
      'status', v_case.status,
      'payout_month', v_case.payout_month,
      'allocation_count', coalesce(v_existing_count, 0),
      'deduction_total', case when v_case.recovery_method = 'payout_deduction' then v_case.debit_amount else 0 end,
      'replayed', true
    );
  end if;

  if v_case.status <> 'awaiting_configuration' then
    raise exception 'Only a Recovery case awaiting configuration can be configured.';
  end if;
  if exists (
    select 1 from public.payment_recovery_allocations allocation
    where allocation.company_id = p_company_id
      and allocation.recovery_case_id = p_recovery_case_id
  ) or exists (
    select 1 from public.payment_recovery_events event
    where event.company_id = p_company_id
      and event.recovery_case_id = p_recovery_case_id
  ) then
    raise exception 'This unconfigured Recovery case already has financial activity. Review it before continuing.';
  end if;

  if v_method = 'post_invoice_dispute' then
    update public.payment_recovery_cases
    set recovery_method = 'post_invoice_dispute',
        status = 'planned_provider_dispute',
        payout_month = null,
        configured_at = pg_catalog.clock_timestamp(),
        configured_by = p_actor_user_id,
        updated_at = pg_catalog.clock_timestamp(),
        updated_by = p_actor_user_id
    where company_id = p_company_id and id = p_recovery_case_id;

    return pg_catalog.jsonb_build_object(
      'case_id', p_recovery_case_id,
      'recovery_method', 'post_invoice_dispute',
      'status', 'planned_provider_dispute',
      'payout_month', null,
      'allocation_count', 0,
      'deduction_total', 0,
      'replayed', false
    );
  end if;

  v_period_end := (p_payout_month + interval '1 month - 1 day')::date;
  v_total_cents := pg_catalog.round(v_case.debit_amount * 100)::bigint;
  if v_total_cents < v_input_count then
    raise exception 'Recovery value is too small to split across % DropX IDs.', v_input_count;
  end if;
  v_base_cents := v_total_cents / v_input_count;
  v_remainder := v_total_cents % v_input_count;

  -- First lock every governing Employee/Contractor source row. Identity
  -- writers cannot pass their source-row lock and take a DropX mutex while
  -- this request proceeds. Recovery requests are serialized above, and the
  -- normalized DropX IDs are sorted.
  foreach v_dropx_id in array v_normalized_ids
  loop
    select pg_catalog.count(*)::integer into v_candidate_count
    from public.payment_recovery_eligible_payout_targets(
      p_company_id, p_payout_month, p_allowed_location_ids
    ) candidate
    where candidate.dropx_id = v_dropx_id;

    if v_candidate_count = 0 then
      raise exception 'DropX ID % has no payout data in %.',
        v_dropx_id, pg_catalog.to_char(p_payout_month, 'Mon-YY');
    end if;
    if v_candidate_count > 1 then
      raise exception 'DropX ID % has more than one payout row in %. Resolve the payout mapping before recovery.',
        v_dropx_id, pg_catalog.to_char(p_payout_month, 'Mon-YY');
    end if;

    select candidate.* into v_candidate
    from public.payment_recovery_eligible_payout_targets(
      p_company_id, p_payout_month, p_allowed_location_ids
    ) candidate
    where candidate.dropx_id = v_dropx_id;

    if v_candidate.target_type = 'employee' then
      perform 1
      from public.employees employee
      where employee.company_id = p_company_id
        and employee.id = v_candidate.target_id
        and public.normalize_people_dropx_id(employee.employee_code) = v_dropx_id
      for update;
      if not found then
        raise exception 'DropX ID % Employee profile changed while Recovery was being configured.', v_dropx_id;
      end if;
    elsif v_candidate.target_type = 'contractor' then
      perform 1
      from public.contractors contractor
      where contractor.company_id = p_company_id
        and contractor.id = v_candidate.target_id
        and public.normalize_people_dropx_id(contractor.dropx_id) = v_dropx_id
      for update;
      if not found then
        raise exception 'DropX ID % Contractor profile changed while Recovery was being configured.', v_dropx_id;
      end if;
    end if;

  end loop;

  -- Publication and other payout writers lock canonical Workforce rows in UUID
  -- order before taking the company payout mutex. Use that same global order;
  -- locking by DropX text would deadlock when UUID and DropX ordering differ.
  perform 1
  from public.workforce workforce
  join (
    select distinct candidate.workforce_id
    from pg_catalog.unnest(v_normalized_ids) selected(dropx_id)
    cross join lateral public.payment_recovery_eligible_payout_targets(
      p_company_id, p_payout_month, p_allowed_location_ids
    ) candidate
    where candidate.dropx_id = selected.dropx_id
      and candidate.workforce_id is not null
  ) selected_workforce on selected_workforce.workforce_id = workforce.id
  where workforce.company_id = p_company_id
  order by workforce.id
  for update of workforce;

  -- With governing source/canonical rows held, take each identity mutex in the
  -- same normalized order used by all multi-ID Recovery requests.
  foreach v_dropx_id in array v_normalized_ids
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_company_id::text || ':dropx:' || v_dropx_id, 0)
    );
  end loop;

  -- Mapping, finalized-payout and payout-input writers share this company
  -- mutex. It is deliberately taken only after all affected profile rows.
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  if v_expected_snapshot_hash is not null then
    v_current_snapshot_hash := public.workforce_advance_recovery_snapshot_hash(
      p_company_id,
      p_payout_month,
      v_period_end
    );
    if v_current_snapshot_hash is distinct from v_expected_snapshot_hash then
      raise exception 'Workforce payout inputs changed while Recovery was being configured. Refresh and try again.';
    end if;
  end if;

  select head.id into v_recovery_head_id
  from public.workforce_deduction_heads head
  where head.company_id = p_company_id
    and pg_catalog.upper(pg_catalog.btrim(head.code)) = 'RECOVERY'
    and head.is_active is true
    and head.is_system is true
    and head.calculation_type = 'manual'
  order by head.id
  limit 1;
  if v_recovery_head_id is null then
    raise exception 'The RECOVERY deduction head is not configured for this company.';
  end if;

  foreach v_dropx_id in array v_normalized_ids
  loop
    v_index := v_index + 1;

    select pg_catalog.count(*)::integer into v_candidate_count
    from public.payment_recovery_eligible_payout_targets(
      p_company_id, p_payout_month, p_allowed_location_ids
    ) candidate
    where candidate.dropx_id = v_dropx_id;

    if v_candidate_count = 0 then
      raise exception 'DropX ID % has no payout data in %.',
        v_dropx_id, pg_catalog.to_char(p_payout_month, 'Mon-YY');
    end if;
    if v_candidate_count > 1 then
      raise exception 'DropX ID % has more than one payout row in %. Resolve the payout mapping before recovery.',
        v_dropx_id, pg_catalog.to_char(p_payout_month, 'Mon-YY');
    end if;

    select candidate.* into v_candidate
    from public.payment_recovery_eligible_payout_targets(
      p_company_id, p_payout_month, p_allowed_location_ids
    ) candidate
    where candidate.dropx_id = v_dropx_id;

    if v_candidate.is_editable is distinct from true then
      raise exception 'DropX ID % cannot be deducted: %',
        v_dropx_id, coalesce(v_candidate.lock_reason, 'the payout is locked');
    end if;

    v_allocation_amount := (
      v_base_cents + case when v_index <= v_remainder then 1 else 0 end
    )::numeric / 100;

    if v_candidate.payout_engine = 'people_payroll' then
      perform 1
      from public.hr_payroll_runs payroll_run
      where payroll_run.company_id = p_company_id
        and payroll_run.id = v_candidate.payout_run_id
        and payroll_run.period_start = p_payout_month
        and payroll_run.period_end = v_period_end
        and payroll_run.status in ('draft', 'calculated')
        and payroll_run.published_at is null
      for update;
      if not found then
        raise exception 'DropX ID % People payroll was locked while Recovery was being configured.', v_dropx_id;
      end if;

      perform 1
      from public.hr_payroll_run_people payroll_person
      where payroll_person.company_id = p_company_id
        and payroll_person.id = v_candidate.payout_run_person_id
        and payroll_person.run_id = v_candidate.payout_run_id
        and payroll_person.worker_type = v_candidate.target_type
        and payroll_person.worker_id = v_candidate.target_id
        and payroll_person.calculation_status = 'ready'
        and greatest(
          coalesce(
            case
              when payroll_person.is_adjusted and payroll_person.adjusted_net_pay is not null
                then payroll_person.adjusted_net_pay
              else payroll_person.net_pay
            end,
            0
          ),
          0
        )
          >= v_allocation_amount
      for update;
      if not found then
        raise exception 'DropX ID % People payroll is blocked or does not have enough available pay for this Recovery.', v_dropx_id;
      end if;
    else
      perform 1
      from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.id = v_candidate.workforce_id
        and workforce.deleted_at is null
        and coalesce(workforce.migration_state, 'canonical') not in ('reclassified', 'moved_to_vendor')
      for update;
      if not found then
        raise exception 'DropX ID % no longer has a canonical Workforce profile for this payout.', v_dropx_id;
      end if;

      select pg_catalog.count(*)::integer into v_workforce_item_count
      from pg_catalog.jsonb_array_elements(coalesce(p_workforce_items, '[]'::jsonb)) item
      where public.normalize_people_dropx_id(item->>'dropx_id') = v_dropx_id
        and pg_catalog.lower(coalesce(item->>'workforce_id', '')) = pg_catalog.lower(v_candidate.workforce_id::text)
        and pg_catalog.lower(coalesce(item->>'station_id', '')) = pg_catalog.lower(v_candidate.station_id::text);
      if v_workforce_item_count <> 1 then
        raise exception 'DropX ID % Workforce payout availability is missing or ambiguous. Refresh and try again.', v_dropx_id;
      end if;

      select item.value into v_workforce_item
      from pg_catalog.jsonb_array_elements(coalesce(p_workforce_items, '[]'::jsonb)) item
      where public.normalize_people_dropx_id(item.value->>'dropx_id') = v_dropx_id
        and pg_catalog.lower(coalesce(item.value->>'workforce_id', '')) = pg_catalog.lower(v_candidate.workforce_id::text)
        and pg_catalog.lower(coalesce(item.value->>'station_id', '')) = pg_catalog.lower(v_candidate.station_id::text)
      limit 1;
      begin
        v_workforce_max_amount := pg_catalog.round(
          coalesce(nullif(v_workforce_item->>'max_amount', '')::numeric, -1),
          2
        );
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'DropX ID % has invalid Workforce payout availability.', v_dropx_id;
      end;
      if nullif(pg_catalog.btrim(v_workforce_item->>'snapshot_hash'), '')
          is distinct from v_expected_snapshot_hash
        or v_workforce_max_amount < v_allocation_amount
      then
        raise exception 'DropX ID % does not have enough available Workforce payout for this Recovery.', v_dropx_id;
      end if;
      v_workforce_items_used := v_workforce_items_used + 1;
    end if;

    insert into public.payment_recovery_allocations(
      company_id, recovery_case_id, imported_dropx_id,
      target_type, target_id, workforce_id, station_id,
      person_name_snapshot, category_snapshot, allocation_amount,
      link_status, allocation_order, linked_at,
      payout_engine, payout_run_id, payout_run_person_id
    ) values (
      p_company_id, p_recovery_case_id, v_dropx_id,
      v_candidate.target_type, v_candidate.target_id,
      v_candidate.workforce_id, v_candidate.station_id,
      v_candidate.person_name,
      case v_candidate.target_type
        when 'employee' then 'Employee'
        when 'contractor' then 'Independent Contractor'
        else 'Workforce'
      end,
      v_allocation_amount, 'linked', v_index, pg_catalog.clock_timestamp(),
      v_candidate.payout_engine, v_candidate.payout_run_id,
      v_candidate.payout_run_person_id
    ) returning id into v_allocation_id;

    insert into public.payment_recovery_events(
      company_id, recovery_case_id, allocation_id,
      event_type, status, amount, period_start, period_end,
      reference, metadata, created_by
    ) values (
      p_company_id, p_recovery_case_id, v_allocation_id,
      'payout_deduction', 'applied', v_allocation_amount,
      p_payout_month, v_period_end, v_case.tid,
      pg_catalog.jsonb_build_object(
        'source', 'payment_recovery',
        'payout_engine', v_candidate.payout_engine,
        'dropx_id', v_dropx_id,
        'payout_month', p_payout_month
      ),
      p_actor_user_id
    );

    if v_candidate.payout_engine = 'people_payroll' then
      insert into public.hr_payroll_run_manual_entries(
        company_id, run_id, worker_type, worker_id, worker_code,
        exception_debit, exception_debit_reason,
        payment_recovery_amount, payment_recovery_note,
        source_file_name, applied_by
      ) values (
        p_company_id, v_candidate.payout_run_id,
        v_candidate.target_type, v_candidate.target_id, v_dropx_id,
        v_allocation_amount,
        'Payment Recovery TID ' || v_case.tid,
        v_allocation_amount,
        'Payment Recovery TID ' || v_case.tid,
        'Payment Recovery register', p_actor_user_id
      )
      on conflict (company_id, run_id, worker_type, worker_id) do update set
        exception_debit = coalesce(public.hr_payroll_run_manual_entries.exception_debit, 0)
          + excluded.payment_recovery_amount,
        exception_debit_reason = pg_catalog.concat_ws(
          '; ',
          nullif(public.hr_payroll_run_manual_entries.exception_debit_reason, ''),
          excluded.exception_debit_reason
        ),
        payment_recovery_amount = public.hr_payroll_run_manual_entries.payment_recovery_amount
          + excluded.payment_recovery_amount,
        payment_recovery_note = pg_catalog.concat_ws(
          '; ',
          nullif(public.hr_payroll_run_manual_entries.payment_recovery_note, ''),
          excluded.payment_recovery_note
        ),
        source_file_name = excluded.source_file_name,
        applied_by = excluded.applied_by,
        applied_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
      returning id into v_manual_entry_id;

      update public.payment_recovery_allocations
      set payroll_manual_entry_id = v_manual_entry_id,
          updated_at = pg_catalog.clock_timestamp()
      where company_id = p_company_id and id = v_allocation_id;

      update public.hr_payroll_run_people payroll_person
      set other_deductions = payroll_person.other_deductions + v_allocation_amount,
          net_pay = payroll_person.net_pay - v_allocation_amount,
          adjusted_net_pay = case
            when payroll_person.is_adjusted and payroll_person.adjusted_net_pay is not null
              then payroll_person.adjusted_net_pay - v_allocation_amount
            else payroll_person.adjusted_net_pay
          end,
          calculation_snapshot = pg_catalog.jsonb_set(
            coalesce(payroll_person.calculation_snapshot, '{}'::jsonb),
            '{payment_recovery_amount}',
            pg_catalog.to_jsonb(
              coalesce((payroll_person.calculation_snapshot->>'payment_recovery_amount')::numeric, 0)
                + v_allocation_amount
            ),
            true
          )
      where payroll_person.company_id = p_company_id
        and payroll_person.id = v_candidate.payout_run_person_id;

      insert into public.hr_payroll_run_items(
        company_id, run_person_id, code, name, item_type,
        amount, source, display_order, metadata
      ) values (
        p_company_id, v_candidate.payout_run_person_id,
        'RECOVERY', 'Recovery', 'deduction',
        v_allocation_amount, 'payment_recovery', 890,
        pg_catalog.jsonb_build_object('last_tid', v_case.tid)
      )
      on conflict (company_id, run_person_id, code, source)
        where code = 'RECOVERY' and source = 'payment_recovery'
      do update set
        amount = public.hr_payroll_run_items.amount + excluded.amount,
        metadata = excluded.metadata;

      update public.hr_payroll_runs payroll_run
      set status = 'calculated',
          deduction_total = (
            select coalesce(pg_catalog.sum(
              person.statutory_deductions
              + person.attendance_deductions
              + person.other_deductions
            ), 0)
            from public.hr_payroll_run_people person
            where person.company_id = p_company_id and person.run_id = payroll_run.id
          ),
          net_total = (
            select coalesce(pg_catalog.sum(
              case
                when person.is_adjusted and person.adjusted_net_pay is not null
                  then person.adjusted_net_pay
                else person.net_pay
              end
            ), 0)
            from public.hr_payroll_run_people person
            where person.company_id = p_company_id and person.run_id = payroll_run.id
          ),
          calculated_by = p_actor_user_id,
          calculated_at = pg_catalog.clock_timestamp(),
          updated_at = pg_catalog.clock_timestamp()
      where payroll_run.company_id = p_company_id
        and payroll_run.id = v_candidate.payout_run_id;
    else
      v_existing_deduction_station_id := null;
      v_existing_deduction_source := null;
      select deduction.station_id, deduction.source_type
      into v_existing_deduction_station_id, v_existing_deduction_source
      from public.workforce_payout_deduction_values deduction
      where deduction.company_id = p_company_id
        and deduction.deduction_head_id = v_recovery_head_id
        and deduction.workforce_id = v_candidate.workforce_id
        and deduction.effective_from = p_payout_month
        and deduction.effective_to = v_period_end
      for update;
      if found and (
        v_existing_deduction_source <> 'payment_recovery'
        or v_existing_deduction_station_id is distinct from v_candidate.station_id
      ) then
        raise exception 'DropX ID % already has a Recovery deduction at another payout location or source for this month.', v_dropx_id;
      end if;

      insert into public.workforce_payout_deduction_values(
        company_id, deduction_head_id, workforce_id, station_id,
        head_code_snapshot, head_name_snapshot,
        effective_from, effective_to, amount,
        source_type, source_batch_id, source_row_id,
        import_metadata, created_by, updated_by
      ) values (
        p_company_id, v_recovery_head_id,
        v_candidate.workforce_id, v_candidate.station_id,
        'RECOVERY', 'Recovery',
        p_payout_month, v_period_end, v_allocation_amount,
        'payment_recovery', null, null,
        pg_catalog.jsonb_build_object(
          'source', 'payment_recovery',
          'last_recovery_case_id', p_recovery_case_id,
          'last_tid', v_case.tid
        ),
        p_actor_user_id, p_actor_user_id
      )
      on conflict on constraint workforce_payout_deduction_values_exact_period_unique
      do update set
        amount = public.workforce_payout_deduction_values.amount + excluded.amount,
        import_metadata = excluded.import_metadata,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.clock_timestamp()
      returning id into v_deduction_value_id;

      update public.payment_recovery_allocations
      set deduction_value_id = v_deduction_value_id,
          updated_at = pg_catalog.clock_timestamp()
      where company_id = p_company_id and id = v_allocation_id;
    end if;
  end loop;

  if v_workforce_items_used
    <> pg_catalog.jsonb_array_length(coalesce(p_workforce_items, '[]'::jsonb))
  then
    raise exception 'One or more Workforce payout availability rows do not match the selected DropX IDs.';
  end if;

  update public.payment_recovery_cases
  set recovery_method = 'payout_deduction',
      status = 'recovered',
      payout_month = p_payout_month,
      configured_at = pg_catalog.clock_timestamp(),
      configured_by = p_actor_user_id,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor_user_id
  where company_id = p_company_id and id = p_recovery_case_id;

  return pg_catalog.jsonb_build_object(
    'case_id', p_recovery_case_id,
    'recovery_method', 'payout_deduction',
    'status', 'recovered',
    'payout_month', p_payout_month,
    'allocation_count', v_input_count,
    'deduction_total', v_case.debit_amount,
    'replayed', false
  );
end;
$function$;

comment on function public.payment_recovery_configure_case(uuid, uuid, text, date, text[], jsonb, uuid, uuid[]) is
  'Atomically configures one imported Recovery case. Payout deductions require exact-month editable payout rows, deterministic paisa allocation and category-appropriate deduction inputs.';

revoke all on function public.payment_recovery_configure_case(uuid, uuid, text, date, text[], jsonb, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.payment_recovery_configure_case(uuid, uuid, text, date, text[], jsonb, uuid, uuid[])
  to service_role;

revoke all on function public.preserve_hr_payment_recovery_manual_entry(),
  public.seed_payment_recovery_deduction_head(),
  public.guard_payment_recovery_deduction_head()
  from public, anon, authenticated;

commit;
