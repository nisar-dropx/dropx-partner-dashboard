-- Preserve immutable bank evidence when a provider-member mapping is moved to
-- another Workforce profile.  A paid instruction always remains attached to
-- its original beneficiary, reference, UTR/CIN and publication allocation.
-- An append-only credit-transfer ledger changes only which Workforce payout
-- balance receives that already-paid allocation.
begin;

create table public.workforce_payout_mapping_payment_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  old_mapping_id uuid not null references public.field_executive_provider_mappings(id) on delete restrict,
  new_mapping_id uuid not null references public.field_executive_provider_mappings(id) on delete restrict,
  source_workforce_id uuid not null,
  destination_workforce_id uuid not null,
  provider_id uuid not null references public.providers(id) on delete restrict,
  provider_member_id_snapshot text not null,
  station_id uuid not null,
  effective_from date not null,
  action text not null check (action in ('none', 'keep', 'transfer')),
  paid_amount_snapshot numeric(14,2) not null check (paid_amount_snapshot >= 0),
  payment_count_snapshot integer not null check (payment_count_snapshot >= 0),
  allocation_count_snapshot integer not null check (allocation_count_snapshot >= 0),
  payment_fingerprint_snapshot text not null
    check (payment_fingerprint_snapshot ~ '^[0-9a-f]{32}$'),
  periods_snapshot jsonb not null check (jsonb_typeof(periods_snapshot) = 'array'),
  result_snapshot jsonb not null check (jsonb_typeof(result_snapshot) = 'object'),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_name_snapshot text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_mapping_payment_decisions_operation_uidx
    unique (company_id, operation_id),
  constraint workforce_payout_mapping_payment_decisions_mapping_uidx
    unique (company_id, old_mapping_id, destination_workforce_id),
  constraint workforce_payout_mapping_payment_decisions_source_company_fk
    foreign key (company_id, source_workforce_id)
    references public.workforce(company_id, id) on delete restrict,
  constraint workforce_payout_mapping_payment_decisions_destination_company_fk
    foreign key (company_id, destination_workforce_id)
    references public.workforce(company_id, id) on delete restrict,
  constraint workforce_payout_mapping_payment_decisions_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id) on delete restrict,
  constraint workforce_payout_mapping_payment_decisions_people_check
    check (source_workforce_id <> destination_workforce_id),
  constraint workforce_payout_mapping_payment_decisions_member_check
    check (nullif(upper(btrim(provider_member_id_snapshot)), '') is not null),
  constraint workforce_payout_mapping_payment_decisions_actor_check
    check (nullif(btrim(actor_name_snapshot), '') is not null),
  constraint workforce_payout_mapping_payment_decisions_action_shape_check
    check (
      (
        action = 'none'
        and paid_amount_snapshot = 0
        and payment_count_snapshot = 0
        and allocation_count_snapshot = 0
      )
      or (
        action in ('keep', 'transfer')
        and paid_amount_snapshot > 0
        and payment_count_snapshot > 0
        and allocation_count_snapshot > 0
      )
    )
);

create index workforce_payout_mapping_payment_decisions_period_idx
  on public.workforce_payout_mapping_payment_decisions(
    company_id, effective_from, source_workforce_id, destination_workforce_id
  );
create index workforce_payout_mapping_payment_decisions_old_mapping_idx
  on public.workforce_payout_mapping_payment_decisions(old_mapping_id);
create index workforce_payout_mapping_payment_decisions_new_mapping_idx
  on public.workforce_payout_mapping_payment_decisions(new_mapping_id);
create index workforce_payout_mapping_payment_decisions_actor_idx
  on public.workforce_payout_mapping_payment_decisions(actor_user_id);
create index workforce_payout_mapping_payment_decisions_provider_idx
  on public.workforce_payout_mapping_payment_decisions(provider_id);

-- Allocation IDs are globally unique, but the credit ledger deliberately
-- carries company_id in every foreign key so cross-tenant references are
-- impossible even if a caller supplies both values. PostgreSQL requires the
-- referenced pair itself to be unique for that composite foreign key.
create unique index if not exists workforce_payout_payment_allocations_company_id_id_uidx
  on public.workforce_payout_payment_allocations(company_id, id);

create table public.workforce_payout_payment_credit_transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  decision_id uuid not null,
  payment_item_id uuid not null,
  payment_allocation_id uuid not null,
  sequence_no integer not null check (sequence_no > 0),
  source_workforce_id uuid not null,
  destination_workforce_id uuid not null,
  station_id uuid not null,
  period_start date not null,
  period_end date not null,
  amount numeric(14,2) not null check (amount > 0),
  original_reference_snapshot text not null,
  original_utr_cin_snapshot text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_credit_transfers_decision_fk
    foreign key (decision_id)
    references public.workforce_payout_mapping_payment_decisions(id)
    on delete restrict deferrable initially deferred,
  constraint workforce_payout_payment_credit_transfers_item_company_fk
    foreign key (company_id, payment_item_id)
    references public.workforce_payout_payment_items(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_credit_transfers_allocation_company_fk
    foreign key (company_id, payment_allocation_id)
    references public.workforce_payout_payment_allocations(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_credit_transfers_source_company_fk
    foreign key (company_id, source_workforce_id)
    references public.workforce(company_id, id) on delete restrict,
  constraint workforce_payout_payment_credit_transfers_destination_company_fk
    foreign key (company_id, destination_workforce_id)
    references public.workforce(company_id, id) on delete restrict,
  constraint workforce_payout_payment_credit_transfers_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id) on delete restrict,
  constraint workforce_payout_payment_credit_transfers_sequence_uidx
    unique (company_id, payment_allocation_id, sequence_no),
  constraint workforce_payout_payment_credit_transfers_decision_allocation_uidx
    unique (decision_id, payment_allocation_id),
  constraint workforce_payout_payment_credit_transfers_period_check check (
    period_start = date_trunc('month', period_start)::date
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_payment_credit_transfers_people_check
    check (source_workforce_id <> destination_workforce_id),
  constraint workforce_payout_payment_credit_transfers_reference_check
    check (nullif(btrim(original_reference_snapshot), '') is not null),
  constraint workforce_payout_payment_credit_transfers_utr_check
    check (nullif(btrim(original_utr_cin_snapshot), '') is not null)
);

create index workforce_payout_payment_credit_transfers_current_idx
  on public.workforce_payout_payment_credit_transfers(
    company_id, payment_allocation_id, sequence_no desc, id desc
  );
create index workforce_payout_payment_credit_transfers_source_period_idx
  on public.workforce_payout_payment_credit_transfers(
    company_id, source_workforce_id, period_start, period_end
  );
create index workforce_payout_payment_credit_transfers_destination_period_idx
  on public.workforce_payout_payment_credit_transfers(
    company_id, destination_workforce_id, period_start, period_end
  );
create index workforce_payout_payment_credit_transfers_item_idx
  on public.workforce_payout_payment_credit_transfers(payment_item_id);

alter table public.workforce_payout_mapping_payment_decisions enable row level security;
alter table public.workforce_payout_mapping_payment_decisions force row level security;
alter table public.workforce_payout_payment_credit_transfers enable row level security;
alter table public.workforce_payout_payment_credit_transfers force row level security;

revoke all on table public.workforce_payout_mapping_payment_decisions,
  public.workforce_payout_payment_credit_transfers
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_mapping_payment_decisions,
  public.workforce_payout_payment_credit_transfers
  to service_role;

create policy workforce_payout_mapping_payment_decisions_service_select
  on public.workforce_payout_mapping_payment_decisions
  for select to service_role using (true);
create policy workforce_payout_payment_credit_transfers_service_select
  on public.workforce_payout_payment_credit_transfers
  for select to service_role using (true);

create or replace function public.guard_workforce_payout_mapping_payment_audit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Workforce payout mapping payment decisions and credit transfers are immutable.';
end
$function$;

create trigger workforce_payout_mapping_payment_decisions_00_audit_guard
before update or delete on public.workforce_payout_mapping_payment_decisions
for each row execute function public.guard_workforce_payout_mapping_payment_audit();

create trigger workforce_payout_payment_credit_transfers_00_audit_guard
before update or delete on public.workforce_payout_payment_credit_transfers
for each row execute function public.guard_workforce_payout_mapping_payment_audit();

-- Provider member IDs in old publication snapshots may be stored at item level
-- or on their signed calculation lines.  Resolve both without trusting current
-- mappings, which may already have been replaced.
create or replace function public.workforce_payout_snapshot_has_provider_member(
  p_snapshot jsonb,
  p_provider_member_id text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select exists (
    select 1
    from jsonb_array_elements_text(case
      when jsonb_typeof(p_snapshot #> '{item,provider_member_ids}') = 'array'
        then p_snapshot #> '{item,provider_member_ids}'
      else '[]'::jsonb
    end) member(value)
    cross join lateral regexp_split_to_table(
      member.value, '[[:space:]]*/[[:space:]]*'
    ) token(value)
    where upper(btrim(token.value)) = upper(btrim(p_provider_member_id))
  ) or upper(btrim(coalesce(p_snapshot #>> '{item,provider_member_id}', '')))
      = upper(btrim(coalesce(p_provider_member_id, '')))
    or exists (
      select 1
      from jsonb_array_elements(case
        when jsonb_typeof(p_snapshot -> 'lines') = 'array'
          then p_snapshot -> 'lines'
        else '[]'::jsonb
      end) line(value)
      cross join lateral regexp_split_to_table(
        coalesce(line.value ->> 'provider_member_id', ''),
        '[[:space:]]*/[[:space:]]*'
      ) token(value)
      where upper(btrim(token.value))
        = upper(btrim(coalesce(p_provider_member_id, '')))
    );
$function$;

create or replace function public.workforce_payout_snapshot_provider_member_count(
  p_snapshot jsonb
)
returns integer
language sql
immutable
set search_path = ''
as $function$
  with raw_values(value) as (
    select member.value
    from jsonb_array_elements_text(case
      when jsonb_typeof(p_snapshot #> '{item,provider_member_ids}') = 'array'
        then p_snapshot #> '{item,provider_member_ids}'
      else '[]'::jsonb
    end) member(value)
    union all
    select p_snapshot #>> '{item,provider_member_id}'
    union all
    select line.value ->> 'provider_member_id'
    from jsonb_array_elements(case
      when jsonb_typeof(p_snapshot -> 'lines') = 'array'
        then p_snapshot -> 'lines'
      else '[]'::jsonb
    end) line(value)
  ), tokens as (
    select upper(btrim(token.value)) as value
    from raw_values raw
    cross join lateral regexp_split_to_table(
      coalesce(raw.value, ''), '[[:space:]]*/[[:space:]]*'
    ) token(value)
  )
  select count(distinct token.value)::integer
  from tokens token
  where nullif(token.value, '') is not null;
$function$;

create or replace function public.workforce_payout_payment_allocation_credit_owner(
  p_company_id uuid,
  p_payment_allocation_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select transfer.destination_workforce_id
      from public.workforce_payout_payment_credit_transfers transfer
      where transfer.company_id = p_company_id
        and transfer.payment_allocation_id = p_payment_allocation_id
      order by transfer.sequence_no desc, transfer.id desc
      limit 1
    ),
    item.workforce_id
  )
  from public.workforce_payout_payment_allocations allocation
  join public.workforce_payout_payment_items item
    on item.company_id = allocation.company_id
   and item.id = allocation.payment_item_id
  where allocation.company_id = p_company_id
    and allocation.id = p_payment_allocation_id;
$function$;

create or replace view public.workforce_payout_effective_paid_allocations
with (security_invoker = true)
as
select
  allocation.company_id,
  allocation.id as payment_allocation_id,
  item.id as payment_item_id,
  item.batch_id,
  item.workforce_id as original_workforce_id,
  item.workforce_id as credited_workforce_id,
  allocation.publication_id,
  allocation.station_id,
  item.period_start,
  item.period_end,
  allocation.instruction_amount_snapshot,
  item.instruction_amount as original_instruction_amount,
  item.status,
  item.reference_no,
  item.utr_cin,
  item.bank_account_no_snapshot,
  item.location_id_snapshot,
  item.location_code_snapshot,
  item.bank_processing_remarks,
  item.payment_version,
  item.created_at,
  item.finalized_at,
  false as was_transferred
from public.workforce_payout_payment_allocations allocation
join public.workforce_payout_payment_items item
  on item.company_id = allocation.company_id
 and item.id = allocation.payment_item_id
where item.status = 'paid'
  and not exists (
    select 1
    from public.workforce_payout_payment_credit_transfers transfer
    where transfer.company_id = allocation.company_id
      and transfer.payment_allocation_id = allocation.id
  )

union all

select
  allocation.company_id,
  allocation.id as payment_allocation_id,
  item.id as payment_item_id,
  item.batch_id,
  item.workforce_id as original_workforce_id,
  transfer.destination_workforce_id as credited_workforce_id,
  allocation.publication_id,
  allocation.station_id,
  item.period_start,
  item.period_end,
  allocation.instruction_amount_snapshot,
  item.instruction_amount as original_instruction_amount,
  item.status,
  item.reference_no,
  item.utr_cin,
  item.bank_account_no_snapshot,
  item.location_id_snapshot,
  item.location_code_snapshot,
  item.bank_processing_remarks,
  item.payment_version,
  item.created_at,
  item.finalized_at,
  true as was_transferred
from public.workforce_payout_payment_allocations allocation
join public.workforce_payout_payment_items item
  on item.company_id = allocation.company_id
 and item.id = allocation.payment_item_id
join public.workforce_payout_payment_credit_transfers transfer
  on transfer.company_id = allocation.company_id
 and transfer.payment_allocation_id = allocation.id
where item.status = 'paid'
  and not exists (
    select 1
    from public.workforce_payout_payment_credit_transfers later
    where later.company_id = transfer.company_id
      and later.payment_allocation_id = transfer.payment_allocation_id
      and later.sequence_no > transfer.sequence_no
  );

revoke all on public.workforce_payout_effective_paid_allocations
  from public, anon, authenticated, service_role;
grant select on public.workforce_payout_effective_paid_allocations to service_role;

create or replace function public.workforce_mapping_paid_history_preview(
  p_company uuid,
  p_expected_old_mapping uuid,
  p_new_workforce uuid,
  p_effective_from date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_mapping public.field_executive_provider_mappings%rowtype;
  v_source_workforce uuid;
  v_paid numeric(14,2) := 0;
  v_payment_count integer := 0;
  v_allocation_count integer := 0;
  v_processing_count integer := 0;
  v_processing_amount numeric(14,2) := 0;
  v_ambiguous_allocation_count integer := 0;
  v_partial_period_allocation_count integer := 0;
  v_payment_fingerprint text;
  v_periods jsonb := '[]'::jsonb;
begin
  if p_company is null or p_expected_old_mapping is null
    or p_new_workforce is null or p_effective_from is null
  then
    raise exception 'Company, existing mapping, destination Workforce and effective date are required.';
  end if;

  select mapping.* into v_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_expected_old_mapping;
  if not found then
    raise exception 'The existing provider mapping is unavailable.';
  end if;
  if v_mapping.station_id is null or v_mapping.provider_id is null
    or nullif(btrim(v_mapping.provider_member_id), '') is null
  then
    raise exception 'The existing provider mapping does not contain a complete payment source identity.';
  end if;

  v_source_workforce := public.workforce_provider_mapping_person(
    v_mapping.company_id, v_mapping.workforce_id,
    v_mapping.field_executive_id, v_mapping.employee_id, v_mapping.contractor_id
  );
  if v_source_workforce is null then
    raise exception 'The existing provider mapping has no canonical Workforce owner.';
  end if;
  if not exists (
    select 1 from public.workforce workforce
    where workforce.company_id = p_company and workforce.id = p_new_workforce
  ) then
    raise exception 'The destination Workforce profile is unavailable.';
  end if;

  with relevant_paid as (
    select effective.*,
      public.workforce_payout_snapshot_provider_member_count(
        publication.snapshot
      ) as provider_member_count
    from public.workforce_payout_effective_paid_allocations effective
    join public.workforce_payout_publications publication
      on publication.company_id = effective.company_id
     and publication.id = effective.publication_id
    where effective.company_id = p_company
      and effective.credited_workforce_id = v_source_workforce
      and effective.station_id = v_mapping.station_id
      and effective.period_end >= p_effective_from
      and public.workforce_payout_snapshot_has_provider_member(
        publication.snapshot, v_mapping.provider_member_id
      )
  ), periods as (
    select
      paid.period_start,
      paid.period_end,
      round(sum(paid.instruction_amount_snapshot), 2) as paid_amount,
      count(distinct paid.payment_item_id)::integer as payment_count,
      count(*)::integer as allocation_count,
      count(*) filter (where paid.provider_member_count <> 1)::integer
        as ambiguous_allocation_count,
      count(*) filter (
        where paid.period_start < p_effective_from
          and p_effective_from <= paid.period_end
      )::integer as partial_period_allocation_count
    from relevant_paid paid
    group by paid.period_start, paid.period_end
  )
  select
    round(coalesce(sum(period.paid_amount), 0), 2),
    coalesce(sum(period.payment_count), 0)::integer,
    coalesce(sum(period.allocation_count), 0)::integer,
    coalesce(sum(period.ambiguous_allocation_count), 0)::integer,
    coalesce(sum(period.partial_period_allocation_count), 0)::integer,
    (
      select md5(coalesce(jsonb_agg(jsonb_build_object(
        'payment_allocation_id', paid.payment_allocation_id,
        'payment_item_id', paid.payment_item_id,
        'credited_workforce_id', paid.credited_workforce_id,
        'station_id', paid.station_id,
        'period_start', paid.period_start,
        'period_end', paid.period_end,
        'amount', paid.instruction_amount_snapshot
      ) order by paid.payment_allocation_id), '[]'::jsonb)::text)
      from relevant_paid paid
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'period_start', period.period_start,
      'period_end', period.period_end,
      'paid_amount', period.paid_amount,
      'payment_count', period.payment_count,
      'allocation_count', period.allocation_count,
      'ambiguous_allocation_count', period.ambiguous_allocation_count,
      'partial_period_allocation_count', period.partial_period_allocation_count
    ) order by period.period_start, period.period_end), '[]'::jsonb)
  into v_paid, v_payment_count, v_allocation_count,
    v_ambiguous_allocation_count, v_partial_period_allocation_count,
    v_payment_fingerprint, v_periods
  from periods period;

  select
    count(distinct item.id)::integer,
    round(coalesce(sum(allocation.instruction_amount_snapshot), 0), 2)
  into v_processing_count, v_processing_amount
  from public.workforce_payout_payment_items item
  join public.workforce_payout_payment_allocations allocation
    on allocation.company_id = item.company_id
   and allocation.payment_item_id = item.id
  join public.workforce_payout_publications publication
    on publication.company_id = allocation.company_id
   and publication.id = allocation.publication_id
  where item.company_id = p_company
    and item.workforce_id = v_source_workforce
    and item.status = 'processing'
    and item.period_end >= p_effective_from
    and allocation.station_id = v_mapping.station_id
    and public.workforce_payout_snapshot_has_provider_member(
      publication.snapshot, v_mapping.provider_member_id
    );

  return jsonb_build_object(
    'has_paid_history', v_paid > 0,
    'paid_amount', v_paid,
    'payment_count', v_payment_count,
    'allocation_count', v_allocation_count,
    'ambiguous_allocation_count', v_ambiguous_allocation_count,
    'partial_period_allocation_count', v_partial_period_allocation_count,
    'payment_fingerprint', v_payment_fingerprint,
    'processing_count', v_processing_count,
    'processing_amount', v_processing_amount,
    'old_workforce_id', v_source_workforce,
    'new_workforce_id', p_new_workforce,
    'station_id', v_mapping.station_id,
    'provider_id', v_mapping.provider_id,
    'provider_member_id', v_mapping.provider_member_id,
    'period_start', case when jsonb_array_length(v_periods) > 0
      then v_periods -> 0 ->> 'period_start' else null end,
    'period_end', case when jsonb_array_length(v_periods) > 0
      then v_periods -> (jsonb_array_length(v_periods) - 1) ->> 'period_end' else null end,
    'periods', v_periods
  );
end
$function$;

create or replace function public.workforce_replace_joining_mapping_with_payment_decision(
  p_company uuid,
  p_actor uuid,
  p_workforce uuid,
  p_expected_old_mapping uuid,
  p_dropx text,
  p_payload jsonb,
  p_locations uuid[],
  p_actor_name text,
  p_payment_transfer_action text,
  p_expected_payment_fingerprint text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_mapping_payment_decisions%rowtype;
  v_old_mapping public.field_executive_provider_mappings%rowtype;
  v_new_mapping public.field_executive_provider_mappings%rowtype;
  v_source_workforce uuid;
  v_effective_from date;
  v_station_id uuid;
  v_action text := lower(btrim(coalesce(p_payment_transfer_action, '')));
  v_fingerprint text;
  v_preview jsonb;
  v_paid numeric(14,2);
  v_payment_count integer;
  v_allocation_count integer;
  v_processing_count integer;
  v_ambiguous_allocation_count integer;
  v_partial_period_allocation_count integer;
  v_actual_payment_fingerprint text;
  v_expected_payment_fingerprint text := lower(btrim(
    coalesce(p_expected_payment_fingerprint, '')
  ));
  v_decision_id uuid := gen_random_uuid();
  v_transferred numeric(14,2) := 0;
  v_transferred_count integer := 0;
  v_result jsonb;
begin
  if p_company is null or p_actor is null or p_workforce is null
    or p_expected_old_mapping is null or p_operation_id is null
  then
    raise exception 'Company, actor, destination Workforce, existing mapping and operation are required.';
  end if;
  if v_action not in ('', 'keep', 'transfer') then
    raise exception 'Payment transfer action must be transfer or keep.';
  end if;
  if v_expected_payment_fingerprint !~ '^[0-9a-f]{32}$' then
    raise exception 'Reload the paid-history confirmation before replacing this mapping.';
  end if;
  begin
    v_effective_from := (p_payload ->> 'effective_from')::date;
    v_station_id := (p_payload ->> 'station_id')::uuid;
  exception when others then
    raise exception 'A valid replacement effective date and location are required.';
  end;

  v_fingerprint := md5(jsonb_build_object(
    'company_id', p_company,
    'actor_id', p_actor,
    'destination_workforce_id', p_workforce,
    'old_mapping_id', p_expected_old_mapping,
    'dropx_id', upper(btrim(coalesce(p_dropx, ''))),
    'payload', p_payload,
    'locations', coalesce(to_jsonb(p_locations), 'null'::jsonb),
    'action', nullif(v_action, ''),
    'expected_payment_fingerprint', v_expected_payment_fingerprint
  )::text);

  select decision.* into v_existing
  from public.workforce_payout_mapping_payment_decisions decision
  where decision.company_id = p_company
    and decision.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      raise exception 'This payment transfer operation ID was already used for another mapping request.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true);
  end if;

  if not exists (select 1 from auth.users actor where actor.id = p_actor) then
    raise exception 'The mapping payment decision actor is unavailable.';
  end if;
  select mapping.* into v_old_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_expected_old_mapping;
  if not found then
    raise exception 'The active mapping changed after payment confirmation.';
  end if;
  v_source_workforce := public.workforce_provider_mapping_person(
    v_old_mapping.company_id, v_old_mapping.workforce_id,
    v_old_mapping.field_executive_id, v_old_mapping.employee_id,
    v_old_mapping.contractor_id
  );
  if v_source_workforce is null or v_source_workforce = p_workforce then
    raise exception 'Paid-history transfer is available only when moving a provider ID to another DropX ID.';
  end if;
  if v_action = 'transfer'
    and v_station_id is distinct from v_old_mapping.station_id
  then
    raise exception 'Paid-history ownership can change only when the replacement keeps the original payout location.';
  end if;

  perform workforce.id
  from public.workforce workforce
  where workforce.company_id = p_company
    and workforce.id = any(array[v_source_workforce, p_workforce])
  order by workforce.id
  for update;
  if (select count(*) from public.workforce workforce
      where workforce.company_id = p_company
        and workforce.id = any(array[v_source_workforce, p_workforce])) <> 2
  then
    raise exception 'The source or destination Workforce profile is unavailable.';
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company);

  select decision.* into v_existing
  from public.workforce_payout_mapping_payment_decisions decision
  where decision.company_id = p_company
    and decision.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      raise exception 'This payment transfer operation ID was already used for another mapping request.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true);
  end if;

  select mapping.* into v_old_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.id = p_expected_old_mapping
  for update;
  if not found or v_old_mapping.status <> 'active' or v_old_mapping.effective_to is not null
  then
    raise exception 'The active mapping changed after payment confirmation.';
  end if;

  v_preview := public.workforce_mapping_paid_history_preview(
    p_company, p_expected_old_mapping, p_workforce, v_effective_from
  );
  v_paid := coalesce((v_preview ->> 'paid_amount')::numeric, 0);
  v_payment_count := coalesce((v_preview ->> 'payment_count')::integer, 0);
  v_allocation_count := coalesce((v_preview ->> 'allocation_count')::integer, 0);
  v_processing_count := coalesce((v_preview ->> 'processing_count')::integer, 0);
  v_ambiguous_allocation_count := coalesce(
    (v_preview ->> 'ambiguous_allocation_count')::integer, 0
  );
  v_partial_period_allocation_count := coalesce(
    (v_preview ->> 'partial_period_allocation_count')::integer, 0
  );
  v_actual_payment_fingerprint := v_preview ->> 'payment_fingerprint';
  if v_actual_payment_fingerprint is distinct from v_expected_payment_fingerprint then
    raise exception 'Payment history changed after confirmation. Reload and review the paid details again.';
  end if;
  if v_processing_count > 0 then
    raise exception 'A matching bank payment is still Processing. Finalize or cancel it before remapping this Provider ID.';
  end if;
  if v_paid > 0 and v_action = '' then
    raise exception 'This Provider ID has partial or full paid history. Choose Transfer payment details or Keep with existing ID.';
  end if;
  if v_paid <= 0 and v_action <> '' then
    raise exception 'This mapping has no finalized paid history to keep or transfer.';
  end if;
  if v_paid <= 0 then
    v_action := 'none';
  end if;
  if v_action = 'transfer' and v_ambiguous_allocation_count > 0 then
    raise exception 'Paid history contains a consolidated bank allocation for multiple Provider IDs. Keep it with the existing ID or resolve that payment allocation before transfer.';
  end if;
  if v_action = 'transfer' and v_partial_period_allocation_count > 0 then
    raise exception 'The replacement date falls inside a paid monthly allocation. Keep its payment details with the existing ID or start the replacement from a later month.';
  end if;

  -- Mapping replacement and the payment decision share this transaction.  The
  -- existing RPC retains all provider mapping, published-period unlock and
  -- station-scope guards.
  perform public.workforce_replace_joining_mapping(
    p_company, p_actor, p_workforce, p_expected_old_mapping, p_dropx,
    p_payload, p_locations, p_actor_name
  );

  select mapping.* into v_new_mapping
  from public.field_executive_provider_mappings mapping
  where mapping.company_id = p_company
    and mapping.workforce_id = p_workforce
    and mapping.provider_id = v_old_mapping.provider_id
    and upper(btrim(mapping.provider_member_id))
      = upper(btrim(v_old_mapping.provider_member_id))
    and mapping.station_id = v_station_id
    and mapping.effective_from = v_effective_from
    and mapping.status = 'active'
    and mapping.effective_to is null
  order by mapping.created_at desc, mapping.id desc
  limit 1;
  if not found then
    raise exception 'The replacement mapping could not be verified after saving.';
  end if;

  if v_action = 'transfer' then
    insert into public.workforce_payout_payment_credit_transfers (
      id, company_id, decision_id, payment_item_id, payment_allocation_id,
      sequence_no, source_workforce_id, destination_workforce_id,
      station_id, period_start, period_end, amount,
      original_reference_snapshot, original_utr_cin_snapshot
    )
    select
      gen_random_uuid(), effective.company_id, v_decision_id,
      effective.payment_item_id, effective.payment_allocation_id,
      coalesce((
        select max(previous.sequence_no)
        from public.workforce_payout_payment_credit_transfers previous
        where previous.company_id = effective.company_id
          and previous.payment_allocation_id = effective.payment_allocation_id
      ), 0) + 1,
      v_source_workforce, p_workforce, effective.station_id,
      effective.period_start, effective.period_end,
      effective.instruction_amount_snapshot,
      effective.reference_no, effective.utr_cin
    from public.workforce_payout_effective_paid_allocations effective
    join public.workforce_payout_publications publication
      on publication.company_id = effective.company_id
     and publication.id = effective.publication_id
    where effective.company_id = p_company
      and effective.credited_workforce_id = v_source_workforce
      and effective.station_id = v_old_mapping.station_id
      and effective.period_end >= v_effective_from
      and public.workforce_payout_snapshot_has_provider_member(
        publication.snapshot, v_old_mapping.provider_member_id
      )
    order by effective.period_start, effective.payment_item_id,
      effective.payment_allocation_id;
    get diagnostics v_transferred_count = row_count;

    select round(coalesce(sum(transfer.amount), 0), 2)
    into v_transferred
    from public.workforce_payout_payment_credit_transfers transfer
    where transfer.decision_id = v_decision_id;
    if v_transferred_count <> v_allocation_count or v_transferred <> v_paid then
      raise exception 'Paid history changed while the mapping transfer was being saved. Reload and review it again.';
    end if;
  end if;

  v_result := jsonb_build_object(
    'new_mapping_id', v_new_mapping.id,
    'payment_action', v_action,
    'paid_amount', v_paid,
    'payment_count', v_payment_count,
    'allocation_count', v_allocation_count,
    'payment_fingerprint', v_actual_payment_fingerprint,
    'transferred_amount', case when v_action = 'transfer' then v_transferred else 0 end,
    'periods', v_preview -> 'periods',
    'source_workforce_id', v_source_workforce,
    'destination_workforce_id', p_workforce,
    'replayed', false
  );

  insert into public.workforce_payout_mapping_payment_decisions (
    id, company_id, operation_id, request_fingerprint,
    old_mapping_id, new_mapping_id,
    source_workforce_id, destination_workforce_id,
    provider_id, provider_member_id_snapshot, station_id, effective_from,
    action, paid_amount_snapshot, payment_count_snapshot,
    allocation_count_snapshot, payment_fingerprint_snapshot,
    periods_snapshot, result_snapshot,
    actor_user_id, actor_name_snapshot
  ) values (
    v_decision_id, p_company, p_operation_id, v_fingerprint,
    v_old_mapping.id, v_new_mapping.id,
    v_source_workforce, p_workforce,
    v_old_mapping.provider_id, v_old_mapping.provider_member_id,
    v_old_mapping.station_id, v_effective_from,
    v_action, v_paid, v_payment_count,
    v_allocation_count, v_actual_payment_fingerprint,
    v_preview -> 'periods', v_result,
    p_actor, coalesce(nullif(btrim(p_actor_name), ''), 'Dashboard mapping reviewer')
  );

  insert into public.workforce_joining_events (
    company_id, workforce_id, event_code, actor_id, actor_name, details
  ) values
  (
    p_company, v_source_workforce, 'provider_mapping_payment_decision',
    p_actor, coalesce(nullif(btrim(p_actor_name), ''), 'Dashboard mapping reviewer'),
    jsonb_build_object(
      'decision_id', v_decision_id,
      'action', v_action,
      'paid_amount', v_paid,
      'payment_count', v_payment_count,
      'destination_workforce_id', p_workforce,
      'old_mapping_id', v_old_mapping.id,
      'new_mapping_id', v_new_mapping.id
    )
  ),
  (
    p_company, p_workforce, 'provider_mapping_payment_decision',
    p_actor, coalesce(nullif(btrim(p_actor_name), ''), 'Dashboard mapping reviewer'),
    jsonb_build_object(
      'decision_id', v_decision_id,
      'action', v_action,
      'paid_amount', v_paid,
      'payment_count', v_payment_count,
      'source_workforce_id', v_source_workforce,
      'old_mapping_id', v_old_mapping.id,
      'new_mapping_id', v_new_mapping.id
    )
  );

  return v_result;
end
$function$;

-- A mapping relock is the final publication boundary.  Refuse it if an owner
-- move with paid history bypassed the explicit keep/transfer decision RPC.
create or replace function public.guard_workforce_payout_paid_mapping_decision_on_relock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_unlock public.workforce_payout_mapping_unlocks%rowtype;
  v_old_mapping public.field_executive_provider_mappings%rowtype;
  v_current_mapping public.field_executive_provider_mappings%rowtype;
  v_old_workforce uuid;
  v_new_workforce uuid;
  v_preview jsonb;
begin
  for v_unlock in
    select unlock.*
    from public.workforce_payout_mapping_unlocks unlock
    where unlock.company_id = new.company_id
      and unlock.id = any(new.unlock_ids)
    order by unlock.id
  loop
    for v_old_mapping in
      select mapping.*
      from public.field_executive_provider_mappings mapping
      where mapping.company_id = new.company_id
        and mapping.id in (
          select (snapshot.value ->> 'id')::uuid
          from jsonb_array_elements(v_unlock.base_mapping_snapshot) snapshot(value)
          where coalesce(snapshot.value ->> 'id', '')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
    loop
      v_old_workforce := public.workforce_provider_mapping_person(
        v_old_mapping.company_id, v_old_mapping.workforce_id,
        v_old_mapping.field_executive_id, v_old_mapping.employee_id,
        v_old_mapping.contractor_id
      );
      if v_old_workforce is null then continue; end if;

      -- Provider IDs may legitimately be retained across more than one
      -- location. Inspect every overlapping successor, irrespective of the
      -- old station, so a cross-station owner change cannot bypass the paid
      -- history decision. Transfer itself remains same-station only.
      for v_current_mapping in
        select mapping.*
        from public.field_executive_provider_mappings mapping
        where mapping.company_id = new.company_id
          and mapping.provider_id = v_old_mapping.provider_id
          and upper(btrim(mapping.provider_member_id))
            = upper(btrim(v_old_mapping.provider_member_id))
          and lower(coalesce(mapping.status, '')) <> 'cancelled'
          and mapping.effective_from <= new.period_end
          and (
            mapping.effective_to is null
            or mapping.effective_to >= new.period_start
          )
        order by mapping.effective_from desc, mapping.created_at desc, mapping.id desc
      loop
        v_new_workforce := public.workforce_provider_mapping_person(
          v_current_mapping.company_id, v_current_mapping.workforce_id,
          v_current_mapping.field_executive_id, v_current_mapping.employee_id,
          v_current_mapping.contractor_id
        );
        if v_new_workforce is null or v_old_workforce = v_new_workforce then
          continue;
        end if;

        v_preview := public.workforce_mapping_paid_history_preview(
          new.company_id, v_old_mapping.id, v_new_workforce,
          greatest(v_current_mapping.effective_from, new.period_start)
        );
        if coalesce((v_preview ->> 'processing_count')::integer, 0) > 0 then
          raise exception 'A matching bank payment is still Processing. Finalize or cancel it before relocking the remapped payout.';
        end if;
        if coalesce((v_preview ->> 'paid_amount')::numeric, 0) > 0
          and not exists (
            select 1
            from public.workforce_payout_mapping_payment_decisions decision
            where decision.company_id = new.company_id
              and decision.old_mapping_id = v_old_mapping.id
              and decision.destination_workforce_id = v_new_workforce
          )
        then
          raise exception 'Choose whether to Transfer paid payment details or Keep them with the existing DropX ID before relocking this payout.';
        end if;
      end loop;
    end loop;
  end loop;
  return new;
end
$function$;

drop trigger if exists workforce_payout_mapping_relocks_00_paid_decision_guard
  on public.workforce_payout_mapping_relocks;
create trigger workforce_payout_mapping_relocks_00_paid_decision_guard
before insert on public.workforce_payout_mapping_relocks
for each row execute function public.guard_workforce_payout_paid_mapping_decision_on_relock();

-- Teach the canonical bank candidate calculator to use the current paid-credit
-- owner rather than the immutable original beneficiary. Processing ownership
-- never moves and therefore remains tied to the original Workforce profile.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select replace(pg_get_functiondef(
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure
  ), chr(13), '') into v_definition;

  v_old := replace($old$
    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0), 2),
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      coalesce(max(item.payment_version), 0)::integer
    into v_profile_paid, v_profile_processing, v_max_payment_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
$old$, chr(13), '');
  v_new := replace($new$
    select round(coalesce(sum(effective.instruction_amount_snapshot), 0), 2)
    into v_profile_paid
    from public.workforce_payout_effective_paid_allocations effective
    where effective.company_id = p_company_id
      and effective.credited_workforce_id = v_workforce_id
      and effective.period_start = p_period_start
      and effective.period_end = p_period_end;

    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      coalesce(max(item.payment_version), 0)::integer
    into v_profile_processing, v_max_payment_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate paid-total structure; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
    ), history_items as (
      select item.id, item.status, item.instruction_amount
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status in ('paid', 'processing')
    ), allocation_rows as (
$old$, chr(13), '');
  v_new := replace($new$
    ), history_items as (
      select
        effective.payment_item_id as id,
        'paid'::text as status,
        round(sum(effective.instruction_amount_snapshot), 2) as instruction_amount
      from public.workforce_payout_effective_paid_allocations effective
      where effective.company_id = p_company_id
        and effective.credited_workforce_id = v_workforce_id
        and effective.period_start = p_period_start
        and effective.period_end = p_period_end
      group by effective.payment_item_id
      union all
      select item.id, item.status, item.instruction_amount
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status = 'processing'
    ), allocation_rows as (
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate history-item structure; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
      left join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = p_company_id
       and allocation.payment_item_id = history_item.id
$old$, chr(13), '');
  v_new := replace($new$
      left join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = p_company_id
       and allocation.payment_item_id = history_item.id
       and (
         history_item.status = 'processing'
         or exists (
           select 1
           from public.workforce_payout_effective_paid_allocations owned
           where owned.company_id = allocation.company_id
             and owned.payment_allocation_id = allocation.id
             and owned.credited_workforce_id = v_workforce_id
         )
       )
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate allocation join; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
          and allocation_publication.workforce_id = v_workforce_id
          and allocation_publication.station_id = allocation.station_id
$old$, chr(13), '');
  v_new := replace($new$
          and (
            history_item.status = 'paid'
            or allocation_publication.workforce_id = v_workforce_id
          )
          and allocation_publication.station_id = allocation.station_id
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate allocation validation; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
    select count(distinct item.id)::integer
    into v_history_count
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
     and allocation.station_id = v_station_id
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
$old$, chr(13), '');
  v_new := replace($new$
    select count(distinct history.item_id)::integer
    into v_history_count
    from (
      select effective.payment_item_id as item_id
      from public.workforce_payout_effective_paid_allocations effective
      where effective.company_id = p_company_id
        and effective.credited_workforce_id = v_workforce_id
        and effective.station_id = v_station_id
        and effective.period_start = p_period_start
        and effective.period_end = p_period_end
      union all
      select item.id
      from public.workforce_payout_payment_items item
      join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = item.company_id
       and allocation.payment_item_id = item.id
       and allocation.station_id = v_station_id
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status <> 'paid'
    ) history;
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate history-count structure; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := replace($old$
    select item.status
    into v_latest_attempt_status
    from public.workforce_payout_payment_items item
    join public.workforce_payout_payment_allocations allocation
      on allocation.company_id = item.company_id
     and allocation.payment_item_id = item.id
     and allocation.station_id = v_station_id
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end
    order by item.payment_version desc, item.id desc
    limit 1;
$old$, chr(13), '');
  v_new := replace($new$
    select history.status
    into v_latest_attempt_status
    from (
      select 'paid'::text as status, effective.finalized_at as occurred_at,
        effective.payment_version, effective.payment_item_id as id
      from public.workforce_payout_effective_paid_allocations effective
      where effective.company_id = p_company_id
        and effective.credited_workforce_id = v_workforce_id
        and effective.station_id = v_station_id
        and effective.period_start = p_period_start
        and effective.period_end = p_period_end
      union all
      select item.status, item.created_at, item.payment_version, item.id
      from public.workforce_payout_payment_items item
      join public.workforce_payout_payment_allocations allocation
        on allocation.company_id = item.company_id
       and allocation.payment_item_id = item.id
       and allocation.station_id = v_station_id
      where item.company_id = p_company_id
        and item.workforce_id = v_workforce_id
        and item.period_start = p_period_start
        and item.period_end = p_period_end
        and item.status <> 'paid'
    ) history
    order by history.occurred_at desc nulls last, history.payment_version desc, history.id desc
    limit 1;
$new$, chr(13), '');
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected Workforce candidate latest-history structure; credit transfer support was not installed.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end
$patch$;

comment on table public.workforce_payout_mapping_payment_decisions is
  'Immutable operator choice made when a provider member with finalized paid history is remapped: keep credit on the old DropX ID or transfer it.';
comment on table public.workforce_payout_payment_credit_transfers is
  'Append-only paid-allocation credit ownership chain. Original bank item, beneficiary, reference and UTR/CIN remain immutable.';
comment on function public.workforce_mapping_paid_history_preview(uuid,uuid,uuid,date) is
  'Returns finalized paid and processing history affected by a proposed provider-member owner replacement.';
comment on function public.workforce_replace_joining_mapping_with_payment_decision(
  uuid,uuid,uuid,uuid,text,jsonb,uuid[],text,text,text,uuid
) is
  'Atomically replaces a provider-member owner and records Keep or transfers finalized paid-allocation credit without rewriting original bank evidence.';

revoke all on function public.guard_workforce_payout_mapping_payment_audit()
  from public, anon, authenticated;
revoke all on function public.workforce_payout_snapshot_has_provider_member(jsonb,text)
  from public, anon, authenticated;
revoke all on function public.workforce_payout_snapshot_provider_member_count(jsonb)
  from public, anon, authenticated;
revoke all on function public.workforce_payout_payment_allocation_credit_owner(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.workforce_mapping_paid_history_preview(uuid,uuid,uuid,date)
  from public, anon, authenticated;
revoke all on function public.workforce_replace_joining_mapping_with_payment_decision(
  uuid,uuid,uuid,uuid,text,jsonb,uuid[],text,text,text,uuid
) from public, anon, authenticated;
revoke all on function public.guard_workforce_payout_paid_mapping_decision_on_relock()
  from public, anon, authenticated;

grant execute on function public.workforce_mapping_paid_history_preview(uuid,uuid,uuid,date)
  to service_role;
grant execute on function public.workforce_replace_joining_mapping_with_payment_decision(
  uuid,uuid,uuid,uuid,text,jsonb,uuid[],text,text,text,uuid
) to service_role;
grant execute on function public.workforce_payout_snapshot_has_provider_member(jsonb,text)
  to service_role;
grant execute on function public.workforce_payout_snapshot_provider_member_count(jsonb)
  to service_role;
grant execute on function public.workforce_payout_payment_allocation_credit_owner(uuid,uuid)
  to service_role;

commit;

notify pgrst, 'reload schema';
