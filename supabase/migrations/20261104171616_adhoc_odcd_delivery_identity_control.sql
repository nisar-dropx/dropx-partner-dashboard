begin;

alter table public.payment_heads
  add column if not exists delivery_identity_policy text not null default 'none';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_heads'::regclass
      and conname = 'payment_heads_delivery_identity_policy_check'
  ) then
    alter table public.payment_heads
      add constraint payment_heads_delivery_identity_policy_check
      check (delivery_identity_policy in ('none', 'legacy_adhoc_da', 'paid_associate_day', 'van_execution'));
  end if;
end $$;

alter table public.payment_requests
  add column if not exists delivery_performer_mode text,
  add column if not exists delivery_work_date date,
  add column if not exists delivery_shipment_id uuid references public.cps_shipment_daily(id) on delete restrict,
  add column if not exists delivery_provider_employee_id text,
  add column if not exists delivery_performer_workforce_id uuid references public.workforce(id) on delete restrict,
  add column if not exists delivery_performer_name text,
  add column if not exists delivery_identity_confirmed boolean not null default false,
  add column if not exists adhoc_payout_effect text not null default 'none';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_requests'::regclass
      and conname = 'payment_delivery_performer_mode_check'
  ) then
    alter table public.payment_requests
      add constraint payment_delivery_performer_mode_check
      check (delivery_performer_mode is null or delivery_performer_mode in ('standalone_odcd', 'van_driver', 'bike_da', 'existing_odcd'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_requests'::regclass
      and conname = 'payment_adhoc_payout_effect_check'
  ) then
    alter table public.payment_requests
      add constraint payment_adhoc_payout_effect_check
      check (adhoc_payout_effect in ('none', 'full_day', 'base_only'));
  end if;
end $$;

create index if not exists payment_delivery_paid_day_idx
  on public.payment_requests(company_id, location_id, delivery_work_date, delivery_provider_employee_id)
  where delivery_identity_confirmed and adhoc_payout_effect <> 'none' and lower(status) in ('processed', 'paid');

update public.payment_heads
set delivery_identity_policy = 'legacy_adhoc_da', updated_at = now()
where code = 'ADHOC_DA' and delivery_identity_policy = 'none';

update public.payment_heads
set name = 'Ad hoc Van (driver/person delivers)',
    updated_at = now()
where code = 'VAN_ADHOC';

insert into public.payment_heads (
  company_id, code, name, external_id, requires_supporting_document, is_active, sort_order,
  final_approval_role_id, final_approval_role_ids, payment_process_role_ids,
  request_expense_approval, expense_approval_threshold,
  initial_approval_role_id, initial_approval_role_ids, supported_payment_modes,
  delivery_identity_policy
)
select
  source.company_id,
  'ADHOC_ODCD',
  'Ad hoc ODCD (person does delivery)',
  'Ad hoc ODCD',
  source.requires_supporting_document,
  false,
  source.sort_order,
  source.final_approval_role_id,
  source.final_approval_role_ids,
  source.payment_process_role_ids,
  source.request_expense_approval,
  source.expense_approval_threshold,
  source.initial_approval_role_id,
  source.initial_approval_role_ids,
  source.supported_payment_modes,
  'paid_associate_day'
from public.payment_heads source
where source.code = 'ADHOC_DA'
  and not exists (
    select 1 from public.payment_heads existing
    where existing.company_id = source.company_id and existing.code = 'ADHOC_ODCD'
  );

insert into public.payment_head_questions (
  company_id, payment_head_id, question_text, answer_type, is_required, sort_order,
  dropdown_options, field_stage, date_rule, date_days
)
select
  target.company_id, target.id, question.question_text, question.answer_type,
  question.is_required, question.sort_order, question.dropdown_options,
  question.field_stage, question.date_rule, question.date_days
from public.payment_heads source
join public.payment_heads target
  on target.company_id = source.company_id and target.code = 'ADHOC_ODCD'
join public.payment_head_questions question on question.payment_head_id = source.id
where source.code = 'ADHOC_DA'
  and not exists (
    select 1 from public.payment_head_questions existing
    where existing.payment_head_id = target.id
      and existing.question_text = question.question_text
      and existing.field_stage = question.field_stage
  );

insert into public.payment_head_approval_steps (
  company_id, payment_head_id, step_order, candidates, is_required
)
select target.company_id, target.id, step.step_order, step.candidates, step.is_required
from public.payment_heads source
join public.payment_heads target
  on target.company_id = source.company_id and target.code = 'ADHOC_ODCD'
join public.payment_head_approval_steps step on step.payment_head_id = source.id
where source.code = 'ADHOC_DA'
  and not exists (
    select 1 from public.payment_head_approval_steps existing
    where existing.payment_head_id = target.id and existing.step_order = step.step_order
  );

update public.payment_head_questions question
set question_text = 'ODCD Contact No', updated_at = now()
from public.payment_heads head
where head.id = question.payment_head_id
  and head.company_id = question.company_id
  and head.code = 'ADHOC_ODCD'
  and question.question_text = 'DA / WM Contact No';

create or replace function public.payment_delivery_identity_roster(
  p_company_id uuid,
  p_station_id uuid,
  p_work_date date
)
returns table(
  shipment_id uuid,
  provider_member_id text,
  associate_name text,
  workforce_id uuid,
  workforce_name text,
  dropx_id text
)
language sql stable security definer set search_path = '' as $$
  with station_provider as (
    select station.station_code, provider.id as provider_id,
      case
        when lower(provider.code || ' ' || provider.name) like '%flipkart%' then 'Flipkart'
        when lower(provider.code || ' ' || provider.name) like '%amazon%' then 'Amazon'
      end as client_name
    from public.stations station
    join public.providers provider
      on provider.company_id = station.company_id and provider.id = station.provider_id
    where station.company_id = p_company_id and station.id = p_station_id
  ), latest_shipments as (
    select distinct on (upper(btrim(shipment.provider_employee_id)))
      shipment.id, shipment.provider_employee_id, shipment.provider_employee_name
    from public.cps_shipment_daily shipment
    join station_provider station on station.station_code = shipment.station_code
    where shipment.company_id = p_company_id
      and lower(shipment.client) = lower(station.client_name)
      and nullif(btrim(shipment.provider_employee_id), '') is not null
      and shipment.work_date <= p_work_date
    order by upper(btrim(shipment.provider_employee_id)), shipment.work_date desc, shipment.id
  ), owners as (
    select
      shipment.id as shipment_id,
      shipment.provider_employee_id,
      shipment.provider_employee_name,
      min(workforce.id::text)::uuid as workforce_id,
      min(workforce.full_name) as workforce_name,
      min(workforce.dropx_id) as dropx_id,
      count(distinct workforce.id) as owner_count
    from latest_shipments shipment
    join station_provider station on true
    join public.field_executive_provider_mappings mapping
      on mapping.company_id = p_company_id
      and mapping.station_id = p_station_id
      and mapping.provider_id = station.provider_id
      and upper(btrim(mapping.provider_member_id)) = upper(btrim(shipment.provider_employee_id))
      and mapping.status in ('active', 'closed')
      and mapping.effective_from <= p_work_date
      and (mapping.effective_to is null or mapping.effective_to >= p_work_date)
    join public.workforce workforce
      on workforce.company_id = mapping.company_id
      and (
        workforce.id = mapping.workforce_id
        or (
          mapping.workforce_id is null
          and (
            workforce.id = mapping.field_executive_id
            or workforce.source_profile_id = coalesce(mapping.contractor_id, mapping.employee_id, mapping.field_executive_id)
          )
        )
      )
    group by shipment.id, shipment.provider_employee_id, shipment.provider_employee_name
  )
  select shipment_id, provider_employee_id,
    coalesce(nullif(btrim(provider_employee_name), ''), workforce_name, provider_employee_id),
    workforce_id, workforce_name, dropx_id
  from owners
  where owner_count = 1
  order by workforce_name nulls last, provider_employee_id;
$$;

create or replace function public.payment_delivery_identity_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  identity_policy text;
  expected_mode text;
  expected_effect text;
  station public.stations;
  shipment public.cps_shipment_daily;
  provider_text text;
  resolved_worker uuid;
  resolved_name text;
  normalized_id text;
begin
  if tg_op = 'DELETE' then
    if old.delivery_identity_confirmed then
      raise exception 'Delivery-linked payments must be cancelled, not deleted';
    end if;
    return old;
  end if;

  select head.delivery_identity_policy into identity_policy
  from public.payment_heads head
  where head.company_id = new.company_id and head.id = new.payment_head_id;
  identity_policy := coalesce(identity_policy, 'none');

  if tg_op = 'UPDATE' and old.delivery_identity_confirmed then
    if row(
      new.company_id, new.location_id, new.payment_head_id, new.delivery_performer_mode,
      new.delivery_work_date, new.delivery_shipment_id, new.delivery_provider_employee_id,
      new.delivery_performer_workforce_id, new.delivery_performer_name,
      new.delivery_identity_confirmed, new.adhoc_payout_effect, new.adhoc_client
    ) is distinct from row(
      old.company_id, old.location_id, old.payment_head_id, old.delivery_performer_mode,
      old.delivery_work_date, old.delivery_shipment_id, old.delivery_provider_employee_id,
      old.delivery_performer_workforce_id, old.delivery_performer_name,
      old.delivery_identity_confirmed, old.adhoc_payout_effect, old.adhoc_client
    ) then
      raise exception 'Delivery identity is frozen. Cancel the unpaid request and create a corrected request';
    end if;
    -- The Master controls new requests. A later Master edit must never strand a
    -- request whose identity and payout treatment were already confirmed.
    if old.adhoc_payout_effect <> 'none'
      and lower(new.status) in ('processed', 'paid')
      and lower(old.status) not in ('processed', 'paid') then
      perform public.lock_workforce_payment_allocation_company(new.company_id);
      if exists (
        select 1 from public.payment_requests request
        where request.company_id = new.company_id
          and request.location_id = old.location_id
          and request.delivery_performer_workforce_id = old.delivery_performer_workforce_id
          and request.delivery_work_date = old.delivery_work_date
          and request.adhoc_payout_effect <> 'none'
          and request.id <> new.id
          and lower(request.status) in ('processed', 'paid')
      ) then
        raise exception 'This associate already has a paid ad hoc request for this location and work date';
      end if;
      if exists (
        select 1 from public.workforce_payout_effective_paid_allocations allocation
        where allocation.company_id = new.company_id
          and allocation.credited_workforce_id = old.delivery_performer_workforce_id
          and allocation.station_id = old.location_id
          and old.delivery_work_date between allocation.period_start and allocation.period_end
      ) or exists (
        select 1
        from public.workforce_payroll_runs run
        join public.workforce_payroll_items item
          on item.payroll_run_id = run.id and item.company_id = run.company_id
        where run.company_id = new.company_id
          and item.workforce_id = old.delivery_performer_workforce_id
          and run.status in ('approved', 'paid')
          and item.status <> 'excluded'
          and old.delivery_work_date between run.period_start and run.period_end
      ) then
        raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
      end if;
      perform public.workforce_bump_payout_period_dependency_revision(new.company_id, old.delivery_work_date);
      perform public.enqueue_workforce_payout_dependency_refresh(
        new.company_id, old.delivery_performer_workforce_id, old.location_id,
        old.delivery_work_date, old.delivery_work_date, new.updated_by
      );
    end if;
    return new;
  end if;

  -- Expense approval is created before payment details are collected.
  if new.amount is null then return new; end if;

  if identity_policy = 'none' then
    if new.delivery_performer_mode is not null or new.delivery_identity_confirmed then
      raise exception 'Delivery identity is not enabled for this payment head';
    end if;
    return new;
  end if;

  -- Existing Ad hoc DA / Wishmaster requests keep their established fields,
  -- reports and payout guard while the policy remains configurable in Master.
  if identity_policy = 'legacy_adhoc_da' then return new; end if;

  if identity_policy = 'paid_associate_day' then
    expected_mode := 'standalone_odcd';
    expected_effect := 'full_day';
  elsif identity_policy = 'van_execution' then
    if new.delivery_performer_mode = 'van_driver' then expected_effect := 'full_day';
    elsif new.delivery_performer_mode = 'bike_da' then expected_effect := 'none';
    elsif new.delivery_performer_mode = 'existing_odcd' then expected_effect := 'base_only';
    else raise exception 'Choose who performed the van deliveries';
    end if;
  else
    raise exception 'Invalid delivery identity policy in Payment Head master';
  end if;

  if expected_mode is not null and new.delivery_performer_mode is distinct from expected_mode then
    raise exception 'Invalid delivery performer type for this payment head';
  end if;
  if not new.delivery_identity_confirmed then
    raise exception 'Confirm that the selected person used their own delivery ID';
  end if;
  if new.delivery_work_date is null then raise exception 'Choose the delivery work date'; end if;

  select * into station from public.stations
  where company_id = new.company_id and id = new.location_id;
  if not found then raise exception 'Select a valid station'; end if;

  select lower(provider.code || ' ' || provider.name) into provider_text
  from public.providers provider
  where provider.company_id = station.company_id and provider.id = station.provider_id;
  if coalesce(provider_text, '') not like '%amazon%' and coalesce(provider_text, '') not like '%flipkart%' then
    raise exception 'Configure the station provider before selecting a delivery ID';
  end if;

  if new.delivery_shipment_id is not null then
    select * into shipment from public.cps_shipment_daily
    where company_id = new.company_id and id = new.delivery_shipment_id
      and station_code = station.station_code
      and lower(client) = case when provider_text like '%flipkart%' then 'flipkart' else 'amazon' end;
    if not found then raise exception 'Select an imported delivery ID from this station and provider'; end if;
    normalized_id := nullif(btrim(shipment.provider_employee_id), '');
  else
    normalized_id := nullif(btrim(new.delivery_provider_employee_id), '');
  end if;

  if normalized_id is null or normalized_id !~ '^[A-Za-z0-9_-]{2,40}$' then
    raise exception 'Enter a valid provider delivery ID';
  end if;
  if provider_text like '%flipkart%' and normalized_id !~ '^[0-9]{12}$' then
    raise exception 'Enter the 12-digit FHR ID from Casper';
  end if;

  resolved_worker := public.resolve_adhoc_paid_day_worker(
    new.company_id,
    new.location_id,
    case when provider_text like '%flipkart%' then 'Flipkart' else 'Amazon' end,
    normalized_id,
    new.delivery_work_date
  );
  if resolved_worker is null then
    raise exception 'This delivery ID is unmapped or has more than one owner for the selected date. Correct ID Mapping before payment';
  end if;
  select workforce.full_name into resolved_name from public.workforce workforce
  where workforce.company_id = new.company_id and workforce.id = resolved_worker;

  new.delivery_provider_employee_id := normalized_id;
  new.delivery_performer_workforce_id := resolved_worker;
  new.delivery_performer_name := resolved_name;
  new.adhoc_payout_effect := expected_effect;
  new.adhoc_client := case when provider_text like '%flipkart%' then 'Flipkart' else 'Amazon' end;
  new.work_date := new.delivery_work_date;
  new.requested_for_name := concat_ws(' / ', resolved_name, normalized_id);

  if expected_effect <> 'none' and lower(new.status) in ('processed', 'paid')
    and (tg_op = 'INSERT' or lower(old.status) not in ('processed', 'paid')) then
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    if exists (
      select 1 from public.payment_requests request
      where request.company_id = new.company_id
        and request.location_id = new.location_id
        and request.delivery_performer_workforce_id = resolved_worker
        and request.delivery_work_date = new.delivery_work_date
        and request.adhoc_payout_effect <> 'none'
        and request.id <> new.id
        and lower(request.status) in ('processed', 'paid')
    ) then
      raise exception 'This associate already has a paid ad hoc request for this location and work date';
    end if;
    if exists (
      select 1 from public.workforce_payout_effective_paid_allocations allocation
      where allocation.company_id = new.company_id
        and allocation.credited_workforce_id = resolved_worker
        and allocation.station_id = new.location_id
        and new.delivery_work_date between allocation.period_start and allocation.period_end
    ) or exists (
      select 1
      from public.workforce_payroll_runs run
      join public.workforce_payroll_items item
        on item.payroll_run_id = run.id and item.company_id = run.company_id
      where run.company_id = new.company_id
        and item.workforce_id = resolved_worker
        and run.status in ('approved', 'paid')
        and item.status <> 'excluded'
        and new.delivery_work_date between run.period_start and run.period_end
    ) then
      raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
    end if;
    perform public.workforce_bump_payout_period_dependency_revision(new.company_id, new.delivery_work_date);
    perform public.enqueue_workforce_payout_dependency_refresh(
      new.company_id, resolved_worker, new.location_id,
      new.delivery_work_date, new.delivery_work_date, new.updated_by
    );
  end if;
  return new;
end $$;

drop trigger if exists payment_delivery_identity_guard on public.payment_requests;
create trigger payment_delivery_identity_guard
before insert or update or delete on public.payment_requests
for each row execute function public.payment_delivery_identity_guard();

revoke all on function public.payment_delivery_identity_roster(uuid, uuid, date), public.payment_delivery_identity_guard()
  from public, anon, authenticated;
grant execute on function public.payment_delivery_identity_roster(uuid, uuid, date) to service_role;

notify pgrst, 'reload schema';
commit;
