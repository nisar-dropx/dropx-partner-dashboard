begin;

-- One immutable receipt for each company/file/scoped-payload import.  The raw
-- file hash is deliberately not unique by itself: the same bank enquiry can be
-- uploaded by two operators whose permitted location subsets do not overlap.
create table if not exists public.central_bank_response_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  file_sha256 text not null,
  file_name text not null,
  normalized_payload_hash text not null,
  normalized_payload jsonb not null,
  result_snapshot jsonb not null,
  imported_by uuid not null references auth.users(id) on delete restrict,
  imported_at timestamptz not null default clock_timestamp(),
  constraint central_bank_response_imports_file_hash_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint central_bank_response_imports_payload_hash_check
    check (normalized_payload_hash ~ '^[0-9a-f]{32}$'),
  constraint central_bank_response_imports_file_name_check
    check (length(btrim(file_name)) between 1 and 240),
  constraint central_bank_response_imports_payload_check
    check (jsonb_typeof(normalized_payload) = 'object'),
  constraint central_bank_response_imports_result_check
    check (jsonb_typeof(result_snapshot) = 'object')
);

create unique index if not exists central_bank_response_imports_operation_uidx
  on public.central_bank_response_imports(company_id, operation_id);
create unique index if not exists central_bank_response_imports_scoped_file_uidx
  on public.central_bank_response_imports(company_id, file_sha256, normalized_payload_hash);
create index if not exists central_bank_response_imports_recent_idx
  on public.central_bank_response_imports(company_id, imported_at desc, id desc);

alter table public.central_bank_response_imports enable row level security;
alter table public.central_bank_response_imports force row level security;
revoke all on table public.central_bank_response_imports from public, anon, authenticated, service_role;
grant select on table public.central_bank_response_imports to service_role;
drop policy if exists central_bank_response_imports_service_select
  on public.central_bank_response_imports;
create policy central_bank_response_imports_service_select
  on public.central_bank_response_imports for select to service_role using (true);

-- Generic payment requests and People payroll historically had no durable UTR
-- registry.  Add one for those two ledgers and cross-check it from the payout
-- ledgers, whose existing registry remains their source of truth.
create table if not exists public.central_bank_paid_transaction_registry (
  company_id uuid not null references public.companies(id) on delete restrict,
  normalized_utr text not null,
  ledger text not null,
  entity_id uuid not null,
  reference_no text not null,
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (company_id, normalized_utr),
  constraint central_bank_paid_transaction_registry_entity_unique
    unique (company_id, ledger, entity_id),
  constraint central_bank_paid_transaction_registry_utr_check check (
    normalized_utr = regexp_replace(upper(btrim(normalized_utr)), '[^A-Z0-9]', '', 'g')
    and normalized_utr not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
  ),
  constraint central_bank_paid_transaction_registry_ledger_check
    check (ledger in ('payment_requests', 'people_payroll')),
  constraint central_bank_paid_transaction_registry_reference_check
    check (nullif(btrim(reference_no), '') is not null)
);

alter table public.central_bank_paid_transaction_registry enable row level security;
alter table public.central_bank_paid_transaction_registry force row level security;
revoke all on table public.central_bank_paid_transaction_registry
  from public, anon, authenticated, service_role;
grant select on table public.central_bank_paid_transaction_registry to service_role;
drop policy if exists central_bank_paid_transaction_registry_service_select
  on public.central_bank_paid_transaction_registry;
create policy central_bank_paid_transaction_registry_service_select
  on public.central_bank_paid_transaction_registry for select to service_role using (true);

-- Preserve existing successful transactions without making deployment depend
-- on historical duplicate cleanup.  A deterministic first claim is kept; all
-- future transitions are protected by the triggers below.
insert into public.central_bank_paid_transaction_registry(
  company_id, normalized_utr, ledger, entity_id, reference_no, claimed_at
)
select distinct on (paid.company_id, paid.normalized_utr)
  paid.company_id, paid.normalized_utr, paid.ledger,
  paid.entity_id, paid.reference_no, paid.claimed_at
from (
  select request.company_id,
    regexp_replace(upper(btrim(coalesce(request.utr_cin, ''))), '[^A-Z0-9]', '', 'g') normalized_utr,
    'payment_requests'::text ledger, request.id entity_id, request.request_no reference_no,
    coalesce(request.processed_at, request.updated_at, request.created_at, clock_timestamp()) claimed_at
  from public.payment_requests request
  where lower(coalesce(request.status, '')) = 'processed'
    or upper(coalesce(request.approval_status, '')) = 'PROCESSED'
  union all
  select line.company_id,
    regexp_replace(upper(btrim(coalesce(line.utr, ''))), '[^A-Z0-9]', '', 'g') normalized_utr,
    'people_payroll'::text ledger, line.id entity_id, line.reference reference_no,
    coalesce(line.updated_at, line.created_at, clock_timestamp()) claimed_at
  from public.hr_payroll_bank_lines line
  where line.status = 'paid'
) paid
where paid.normalized_utr not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
  and not exists (
    select 1 from public.payout_bank_paid_transaction_registry payout
    where payout.company_id = paid.company_id
      and payout.normalized_utr = paid.normalized_utr
  )
order by paid.company_id, paid.normalized_utr, paid.claimed_at, paid.ledger, paid.entity_id
on conflict do nothing;

create or replace function public.claim_central_bank_paid_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_ledger text;
  v_entity_id uuid;
  v_reference text;
  v_is_paid boolean;
  v_was_paid boolean := false;
  v_utr text;
  v_old_utr text := '';
  v_normalized_utr text;
  v_old_normalized_utr text := '';
  v_existing public.central_bank_paid_transaction_registry%rowtype;
begin
  if tg_table_name = 'payment_requests' then
    v_ledger := 'payment_requests';
    v_entity_id := new.id;
    v_reference := new.request_no;
    v_is_paid := lower(coalesce(new.status, '')) = 'processed'
      or upper(coalesce(new.approval_status, '')) = 'PROCESSED';
    v_utr := coalesce(new.utr_cin, '');
    if tg_op = 'UPDATE' then
      v_was_paid := lower(coalesce(old.status, '')) = 'processed'
        or upper(coalesce(old.approval_status, '')) = 'PROCESSED';
      v_old_utr := coalesce(old.utr_cin, '');
    end if;
  else
    v_ledger := 'people_payroll';
    v_entity_id := new.id;
    v_reference := new.reference;
    v_is_paid := new.status = 'paid';
    v_utr := coalesce(new.utr, '');
    if tg_op = 'UPDATE' then
      v_was_paid := old.status = 'paid';
      v_old_utr := coalesce(old.utr, '');
    end if;
  end if;

  if not v_is_paid then return new; end if;
  v_normalized_utr := regexp_replace(upper(btrim(v_utr)), '[^A-Z0-9]', '', 'g');
  v_old_normalized_utr := regexp_replace(upper(btrim(v_old_utr)), '[^A-Z0-9]', '', 'g');
  if v_was_paid then
    if v_old_normalized_utr <> '' and v_old_normalized_utr <> v_normalized_utr then
      raise exception 'Bank UTR/CIN cannot be replaced after a payment is marked paid.';
    end if;
    if v_old_normalized_utr <> '' then return new; end if;
  end if;
  if v_normalized_utr in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE') then
    -- The retained People Payroll importer historically accepts a PAID result
    -- without UTR.  Do not change that legacy contract here; the new central
    -- finalizer itself remains strict and rejects such a row before mutation.
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'central-bank-paid-utr:' || new.company_id::text || ':' || v_normalized_utr,
    0
  ));
  if exists (
    select 1 from public.payout_bank_paid_transaction_registry payout
    where payout.company_id = new.company_id
      and payout.normalized_utr = v_normalized_utr
  ) then
    raise exception 'This UTR/CIN is already recorded for another paid instruction.';
  end if;

  insert into public.central_bank_paid_transaction_registry(
    company_id, normalized_utr, ledger, entity_id, reference_no
  ) values (
    new.company_id, v_normalized_utr, v_ledger, v_entity_id, v_reference
  ) on conflict (company_id, normalized_utr) do nothing;
  if not found then
    select claim.* into v_existing
    from public.central_bank_paid_transaction_registry claim
    where claim.company_id = new.company_id
      and claim.normalized_utr = v_normalized_utr;
    if v_existing.ledger <> v_ledger or v_existing.entity_id <> v_entity_id then
      raise exception 'This UTR/CIN is already recorded for another paid instruction.';
    end if;
  end if;
  return new;
end
$function$;

create or replace function public.guard_payout_against_central_paid_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_normalized_utr text;
begin
  if new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
    return new;
  end if;
  v_normalized_utr := regexp_replace(
    upper(btrim(coalesce(new.utr_cin, ''))), '[^A-Z0-9]', '', 'g'
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'central-bank-paid-utr:' || new.company_id::text || ':' || v_normalized_utr,
    0
  ));
  if exists (
    select 1 from public.central_bank_paid_transaction_registry claim
    where claim.company_id = new.company_id
      and claim.normalized_utr = v_normalized_utr
  ) then
    raise exception 'This UTR/CIN is already recorded for another paid instruction.';
  end if;
  return new;
end
$function$;

drop trigger if exists payment_requests_90_central_paid_transaction
  on public.payment_requests;
create trigger payment_requests_90_central_paid_transaction
before insert or update of status, approval_status, utr_cin on public.payment_requests
for each row execute function public.claim_central_bank_paid_transaction();

drop trigger if exists hr_payroll_bank_lines_90_central_paid_transaction
  on public.hr_payroll_bank_lines;
create trigger hr_payroll_bank_lines_90_central_paid_transaction
before insert or update of status, utr on public.hr_payroll_bank_lines
for each row execute function public.claim_central_bank_paid_transaction();

drop trigger if exists workforce_payout_payment_items_80_central_utr_guard
  on public.workforce_payout_payment_items;
create trigger workforce_payout_payment_items_80_central_utr_guard
before insert or update of status, utr_cin on public.workforce_payout_payment_items
for each row execute function public.guard_payout_against_central_paid_transaction();

drop trigger if exists helper_payout_payment_items_80_central_utr_guard
  on public.helper_payout_payment_items;
create trigger helper_payout_payment_items_80_central_utr_guard
before insert or update of status, utr_cin on public.helper_payout_payment_items
for each row execute function public.guard_payout_against_central_paid_transaction();

revoke all on function public.claim_central_bank_paid_transaction()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_payout_against_central_paid_transaction()
  from public, anon, authenticated, service_role;

-- Set-based reference ownership/scope resolver for the central upload API.
-- Unknown references are omitted; multiple rows for one reference deliberately
-- expose an ambiguity which the API and finalizer must reject.
create or replace function public.resolve_central_bank_response_references(
  p_company_id uuid,
  p_references jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_result jsonb;
begin
  if p_company_id is null
    or not exists (select 1 from public.companies company where company.id = p_company_id)
  then
    raise exception 'Company was not found.';
  end if;
  if jsonb_typeof(p_references) is distinct from 'array' then
    raise exception 'Bank response references must be an array.';
  end if;
  v_count := jsonb_array_length(p_references);
  if v_count < 1 or v_count > 5000 then
    raise exception 'Resolve between 1 and 5000 bank response references at a time.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_references) reference(value)
    where jsonb_typeof(reference.value) is distinct from 'string'
      or public.workforce_payout_bank_reference_canonical(reference.value #>> '{}') = ''
      or length(public.workforce_payout_bank_reference_canonical(reference.value #>> '{}')) > 128
  ) then
    raise exception 'Every bank response reference must be a non-empty string of at most 128 characters.';
  end if;

  with requested as (
    select
      min(reference.ordinality)::bigint input_order,
      public.workforce_payout_bank_reference_canonical(reference.value #>> '{}') reference_no
    from jsonb_array_elements(p_references) with ordinality reference(value, ordinality)
    group by public.workforce_payout_bank_reference_canonical(reference.value #>> '{}')
  ), matches as (
    select requested.input_order, 0 ledger_order, 'workforce'::text ledger,
      item.reference_no, item.id, item.location_id_snapshot location_id,
      item.status, null::text approval_status, null::uuid current_approver_user_id,
      null::uuid current_approver_role_id, '{}'::uuid[] current_approver_role_ids,
      '{}'::uuid[] payment_process_role_ids, null::text payment_mode,
      item.batch_id, null::uuid run_id, item.workforce_id worker_id, 'workforce'::text worker_type
    from requested
    join public.workforce_payout_payment_items item
      on item.company_id = p_company_id and item.reference_no = requested.reference_no
    union all
    select requested.input_order, 1, 'helpers', item.reference_no, item.id,
      item.location_id_snapshot, item.status, null, null::uuid, null::uuid,
      '{}'::uuid[], '{}'::uuid[], null, item.batch_id, null::uuid,
      item.helper_id, 'helper'
    from requested
    join public.helper_payout_payment_items item
      on item.company_id = p_company_id and item.reference_no = requested.reference_no
    union all
    select requested.input_order, 2, 'payment_requests', request.request_no, request.id,
      request.location_id, request.status, request.approval_status,
      request.current_approver_user_id, request.current_approver_role_id,
      coalesce(request.current_approver_role_ids, '{}'::uuid[]),
      coalesce(request.payment_process_role_ids, '{}'::uuid[]), request.payment_mode,
      null::uuid, null::uuid, null::uuid, null::text
    from requested
    join public.payment_requests request
      on request.company_id = p_company_id and request.request_no = requested.reference_no
    union all
    select requested.input_order, 3, 'people_payroll', line.reference, line.id,
      person.location_id, line.status, null, null::uuid, null::uuid,
      '{}'::uuid[], '{}'::uuid[], 'account_transfer', null::uuid, line.run_id,
      line.worker_id, line.worker_type
    from requested
    join public.hr_payroll_bank_lines line
      on line.company_id = p_company_id and line.reference = requested.reference_no
    left join public.hr_payroll_run_people person
      on person.company_id = line.company_id and person.run_id = line.run_id
      and person.worker_id = line.worker_id and person.worker_type = line.worker_type
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ledger', matches.ledger,
    'reference_no', matches.reference_no,
    'id', matches.id,
    'location_id', matches.location_id,
    'status', matches.status,
    'approval_status', matches.approval_status,
    'current_approver_user_id', matches.current_approver_user_id,
    'current_approver_role_id', matches.current_approver_role_id,
    'current_approver_role_ids', to_jsonb(matches.current_approver_role_ids),
    'payment_process_role_ids', to_jsonb(matches.payment_process_role_ids),
    'payment_mode', matches.payment_mode,
    'batch_id', matches.batch_id,
    'run_id', matches.run_id,
    'worker_id', matches.worker_id,
    'worker_type', matches.worker_type
  ) order by matches.input_order, matches.ledger_order), '[]'::jsonb)
  into v_result
  from matches;
  return v_result;
end
$function$;

comment on function public.resolve_central_bank_response_references(uuid, jsonb) is
  'Resolves up to 5000 normalized bank references across the four central payment ledgers in one company-scoped query.';
revoke all on function public.resolve_central_bank_response_references(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_central_bank_response_references(uuid, jsonb)
  to service_role;

-- Finalize all company-owned portions of one Federal Bank enquiry in one
-- transaction.  The application decides permissions/location scope and sends
-- only that subset; this function re-checks company ownership, ambiguity and
-- immutable bank instruction values before it changes any ledger.
create or replace function public.finalize_central_bank_response(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_file_sha256 text,
  p_file_name text,
  p_workforce_rows jsonb,
  p_helper_rows jsonb,
  p_payment_request_rows jsonb,
  p_payroll_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_scoped_payout_hash text;
  v_existing public.central_bank_response_imports%rowtype;
  v_import_id uuid := gen_random_uuid();
  v_operation_lock bigint;
  v_file_lock bigint;
  v_total_count integer;
  v_ledger text;
  v_row_record record;
  v_row jsonb;
  v_row_number integer;
  v_reference text;
  v_owner_count integer;
  v_expected_owner boolean;
  v_seen_references text[] := '{}'::text[];
  v_seen_utrs text[] := '{}'::text[];
  v_seen_utr_references text[] := '{}'::text[];
  v_seen_index integer;
  v_status text;
  v_utr text;
  v_utr_normalized text;
  v_debit_account text;
  v_value_date_text text;
  v_expected_debit_account text;
  v_expected_value_date date;

  v_payout_result jsonb;
  v_generic_rows jsonb := '[]'::jsonb;
  v_payroll_result_rows jsonb := '[]'::jsonb;
  v_combined_rows jsonb := '[]'::jsonb;
  v_payment_events jsonb := '[]'::jsonb;
  v_payroll_run_ids uuid[] := '{}'::uuid[];
  v_run_id uuid;

  v_request public.payment_requests%rowtype;
  v_payroll_line public.hr_payroll_bank_lines%rowtype;
  v_account text;
  v_ifsc text;
  v_expected_account text;
  v_expected_ifsc text;
  v_amount_paise_text text;
  v_amount_paise numeric;
  v_expected_amount_paise numeric;
  v_remarks text;
  v_sequence integer;

  v_generic_paid integer := 0;
  v_generic_cancelled integer := 0;
  v_generic_replayed integer := 0;
  v_generic_rejected integer := 0;
  v_payroll_paid integer := 0;
  v_payroll_cancelled integer := 0;
  v_payroll_replayed integer := 0;
  v_payroll_rejected integer := 0;
  v_generic_result jsonb;
  v_payroll_result jsonb;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required for a central bank response.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 bank response file hash is required.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid bank response file name is required.';
  end if;
  if jsonb_typeof(p_workforce_rows) is distinct from 'array'
    or jsonb_typeof(p_helper_rows) is distinct from 'array'
    or jsonb_typeof(p_payment_request_rows) is distinct from 'array'
    or jsonb_typeof(p_payroll_rows) is distinct from 'array'
  then
    raise exception 'Every central bank response ledger payload must be an array.';
  end if;

  v_total_count := jsonb_array_length(p_workforce_rows)
    + jsonb_array_length(p_helper_rows)
    + jsonb_array_length(p_payment_request_rows)
    + jsonb_array_length(p_payroll_rows);
  if v_total_count < 1 or v_total_count > 5000 then
    raise exception 'Central bank response must contain between 1 and 5000 company-owned rows.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  v_payload := jsonb_build_object(
    'workforce', p_workforce_rows,
    'helpers', p_helper_rows,
    'payment_requests', p_payment_request_rows,
    'people_payroll', p_payroll_rows
  );
  -- jsonb text has canonical key ordering.  MD5 is used only as a compact
  -- index key; an exact jsonb comparison below remains the integrity check.
  v_payload_hash := md5(v_payload::text);
  v_scoped_payout_hash := md5(p_file_sha256 || ':' || v_payload::text)
    || md5(v_payload::text || ':' || p_file_sha256);
  v_operation_lock := pg_catalog.hashtextextended(
    'central-bank-response:operation:' || p_company_id::text || ':' || p_operation_id::text,
    0
  );
  v_file_lock := pg_catalog.hashtextextended(
    'central-bank-response:file:' || p_company_id::text || ':' || p_file_sha256 || ':' || v_payload_hash,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(least(v_operation_lock, v_file_lock));
  if v_operation_lock <> v_file_lock then
    perform pg_catalog.pg_advisory_xact_lock(greatest(v_operation_lock, v_file_lock));
  end if;

  select imported.* into v_existing
  from public.central_bank_response_imports imported
  where imported.company_id = p_company_id
    and imported.operation_id = p_operation_id;
  if found then
    if v_existing.file_sha256 <> p_file_sha256
      or v_existing.normalized_payload is distinct from v_payload
    then
      raise exception 'This central bank response operation ID was already used for a different file or scoped payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object(
      'replayed', true,
      'central_import_id', v_existing.id,
      'payment_request_events', '[]'::jsonb,
      'payroll_run_ids', '[]'::jsonb
    );
  end if;

  select imported.* into v_existing
  from public.central_bank_response_imports imported
  where imported.company_id = p_company_id
    and imported.file_sha256 = p_file_sha256
    and imported.normalized_payload_hash = v_payload_hash;
  if found then
    if v_existing.normalized_payload is distinct from v_payload then
      raise exception 'The scoped bank response payload hash collided with a different normalized payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object(
      'replayed', true,
      'central_import_id', v_existing.id,
      'payment_request_events', '[]'::jsonb,
      'payroll_run_ids', '[]'::jsonb
    );
  end if;

  -- Every path (central or one of the retained legacy upload screens) uses
  -- this same transaction lock before claiming a paid UTR.  Central files can
  -- contain many paid rows, so acquire their locks in canonical order to avoid
  -- deadlocks between concurrent imports.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'central-bank-paid-utr:' || p_company_id::text || ':' || paid.normalized_utr,
    0
  ))
  from (
    select distinct regexp_replace(
      upper(btrim(coalesce(response.value ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
    ) normalized_utr
    from (
      values (p_workforce_rows), (p_helper_rows),
        (p_payment_request_rows), (p_payroll_rows)
    ) source(rows)
    cross join lateral jsonb_array_elements(source.rows) response(value)
    where upper(btrim(coalesce(response.value ->> 'status', ''))) = 'PAID'
  ) paid
  where paid.normalized_utr not in (
    '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
  )
  order by paid.normalized_utr;

  -- Validate every caller-classified reference before invoking any ledger
  -- finalizer.  A reference which exists in two ledgers is ambiguous and the
  -- entire scoped import fails closed.
  for v_row_record in
    select source.ledger, response.value, response.ordinality::integer as position
    from (
      values
        ('workforce'::text, p_workforce_rows),
        ('helpers'::text, p_helper_rows),
        ('payment_requests'::text, p_payment_request_rows),
        ('people_payroll'::text, p_payroll_rows)
    ) source(ledger, rows)
    cross join lateral jsonb_array_elements(source.rows)
      with ordinality response(value, ordinality)
    order by source.ledger, response.ordinality
  loop
    v_ledger := v_row_record.ledger;
    v_row := v_row_record.value;
    if jsonb_typeof(v_row) is distinct from 'object' then
      raise exception 'Every central bank response row must be an object.';
    end if;
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    if v_reference = '' or length(v_reference) > 128 then
      raise exception 'Every central bank response row must contain a valid customer reference.';
    end if;
    if v_reference = any(v_seen_references) then
      raise exception 'The scoped bank response contains customer reference % more than once.', v_reference;
    end if;
    v_seen_references := array_append(v_seen_references, v_reference);

    select
      (exists (
        select 1 from public.workforce_payout_payment_items item
        where item.company_id = p_company_id and item.reference_no = v_reference
      ))::integer
      + (exists (
        select 1 from public.helper_payout_payment_items item
        where item.company_id = p_company_id and item.reference_no = v_reference
      ))::integer
      + (exists (
        select 1 from public.payment_requests request
        where request.company_id = p_company_id
          and public.workforce_payout_bank_reference_canonical(request.request_no) = v_reference
      ))::integer
      + (exists (
        select 1 from public.hr_payroll_bank_lines line
        where line.company_id = p_company_id
          and public.workforce_payout_bank_reference_canonical(line.reference) = v_reference
      ))::integer
    into v_owner_count;

    v_expected_owner := case v_ledger
      when 'workforce' then exists (
        select 1 from public.workforce_payout_payment_items item
        where item.company_id = p_company_id and item.reference_no = v_reference
      )
      when 'helpers' then exists (
        select 1 from public.helper_payout_payment_items item
        where item.company_id = p_company_id and item.reference_no = v_reference
      )
      when 'payment_requests' then exists (
        select 1 from public.payment_requests request
        where request.company_id = p_company_id
          and public.workforce_payout_bank_reference_canonical(request.request_no) = v_reference
      )
      when 'people_payroll' then exists (
        select 1 from public.hr_payroll_bank_lines line
        where line.company_id = p_company_id
          and public.workforce_payout_bank_reference_canonical(line.reference) = v_reference
      )
      else false
    end;
    if v_owner_count <> 1 or not v_expected_owner then
      raise exception 'Customer reference % is missing, ambiguous, or assigned to the wrong payment ledger for this company.', v_reference;
    end if;

    -- Debit account and value date are optional in older enquiry exports.  If
    -- Federal Bank supplies them for a payout ledger, they must match the
    -- frozen batch instruction too.
    v_debit_account := public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account');
    v_value_date_text := btrim(coalesce(v_row ->> 'value_date', ''));
    if v_ledger = 'workforce' then
      select batch.debit_account_no_snapshot, batch.value_date
      into v_expected_debit_account, v_expected_value_date
      from public.workforce_payout_payment_items item
      join public.workforce_payout_payment_batches batch on batch.id = item.batch_id
      where item.company_id = p_company_id and item.reference_no = v_reference;
    elsif v_ledger = 'helpers' then
      select batch.debit_account_no_snapshot, batch.value_date
      into v_expected_debit_account, v_expected_value_date
      from public.helper_payout_payment_items item
      join public.helper_payout_payment_batches batch on batch.id = item.batch_id
      where item.company_id = p_company_id and item.reference_no = v_reference;
    else
      v_expected_debit_account := null;
      v_expected_value_date := null;
    end if;
    if v_ledger in ('workforce', 'helpers')
      and v_debit_account <> ''
      and v_debit_account <> public.workforce_payout_bank_account_canonical(v_expected_debit_account)
    then
      raise exception 'Debit account does not match the generated instruction for reference %.', v_reference;
    end if;
    if v_ledger in ('workforce', 'helpers')
      and v_value_date_text <> ''
      and (v_value_date_text !~ '^\d{4}-\d{2}-\d{2}$'
        or v_value_date_text::date is distinct from v_expected_value_date)
    then
      raise exception 'Value date does not match the generated instruction for reference %.', v_reference;
    end if;

    v_status := upper(btrim(coalesce(v_row ->> 'status', '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr := btrim(coalesce(v_row ->> 'utr_cin', ''));
    v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
    if v_status = 'PAID'
      and v_utr_normalized not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    then
      v_seen_index := array_position(v_seen_utrs, v_utr_normalized);
      if v_seen_index is not null
        and v_seen_utr_references[v_seen_index] <> v_reference
      then
        raise exception 'The same UTR/CIN is attached to more than one payment in this scoped bank response.';
      end if;
      if v_seen_index is null then
        v_seen_utrs := array_append(v_seen_utrs, v_utr_normalized);
        v_seen_utr_references := array_append(v_seen_utr_references, v_reference);
      end if;

      -- Protect the four ledgers from reusing evidence already attached to a
      -- different paid instruction, including records written by legacy upload
      -- screens before the central importer existed.
      if exists (
        select 1 from public.payout_bank_paid_transaction_registry paid
        where paid.company_id = p_company_id
          and paid.normalized_utr = v_utr_normalized
          and public.workforce_payout_bank_reference_canonical(paid.reference_no) <> v_reference
      ) or exists (
        select 1 from public.payment_requests request
        where request.company_id = p_company_id
          and lower(request.status) = 'processed'
          and regexp_replace(upper(btrim(coalesce(request.utr_cin, ''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized
          and public.workforce_payout_bank_reference_canonical(request.request_no) <> v_reference
      ) or exists (
        select 1 from public.hr_payroll_bank_lines line
        where line.company_id = p_company_id and line.status = 'paid'
          and regexp_replace(upper(btrim(coalesce(line.utr, ''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized
          and public.workforce_payout_bank_reference_canonical(line.reference) <> v_reference
      ) then
        raise exception 'This UTR/CIN is already recorded for another paid instruction.';
      end if;
    end if;
  end loop;

  -- Preserve the existing Workforce/Helper finalizers.  They remain the sole
  -- mutation path for their immutable ledgers and any error rolls back this
  -- outer transaction, including the other ledgers below.
  if jsonb_array_length(p_workforce_rows) + jsonb_array_length(p_helper_rows) > 0 then
    v_payout_result := public.finalize_owned_payout_payment_response(
      p_company_id,
      p_actor_user_id,
      p_operation_id,
      v_scoped_payout_hash,
      p_file_name,
      p_workforce_rows,
      p_helper_rows
    );
  end if;

  for v_row_record in
    select response.value, response.ordinality::integer as position
    from jsonb_array_elements(p_payment_request_rows)
      with ordinality response(value, ordinality)
    order by response.ordinality
  loop
    v_row := v_row_record.value;
    v_row_number := v_row_record.position;
    if coalesce(v_row ->> 'row_number', '') ~ '^[1-9][0-9]*$' then
      v_row_number := (v_row ->> 'row_number')::integer;
    end if;
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    v_account := public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account');
    v_ifsc := public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc');
    v_amount_paise_text := btrim(coalesce(v_row ->> 'debit_amount_paise', ''));
    v_status := upper(btrim(coalesce(v_row ->> 'status', '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr := btrim(coalesce(v_row ->> 'utr_cin', ''));
    v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
    v_remarks := btrim(coalesce(v_row ->> 'remarks', ''));

    select request.* into v_request
    from public.payment_requests request
    where request.company_id = p_company_id
      and public.workforce_payout_bank_reference_canonical(request.request_no) = v_reference
    for update;
    if not found then
      raise exception 'Payment request % no longer belongs to this company.', v_reference;
    end if;

    v_expected_account := public.workforce_payout_bank_account_canonical(coalesce(
      nullif(v_request.beneficiary_account_number, ''),
      nullif(v_request.beneficiary_account_no, ''),
      v_request.bank_account_no
    ));
    v_expected_ifsc := public.workforce_payout_bank_ifsc_canonical(coalesce(
      nullif(v_request.beneficiary_ifsc, ''),
      v_request.ifsc
    ));
    v_expected_amount_paise := round(coalesce(v_request.amount, v_request.amount_requested, 0) * 100, 0);

    if lower(coalesce(v_request.payment_mode, 'account_transfer')) <> 'account_transfer' then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Only account-transfer payment requests can be finalized from a bank enquiry.'
      ));
      continue;
    end if;
    if v_amount_paise_text !~ '^[1-9][0-9]*$' then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Debit amount paise must be a positive integer.'
      ));
      continue;
    end if;
    v_amount_paise := v_amount_paise_text::numeric;
    if v_account !~ '^[A-Z0-9]{4,30}$'
      or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> v_expected_account
      or v_ifsc <> v_expected_ifsc
      or v_amount_paise <> v_expected_amount_paise
    then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Account, IFSC or exact debit amount does not match the payment request.'
      ));
      continue;
    end if;
    if v_status not in ('PAID', 'CANCELLED') then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Status must be PAID or CANCELLED.'
      ));
      continue;
    end if;
    if v_status = 'PAID'
      and v_utr_normalized in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'A meaningful bank UTR/CIN is required for a paid payment request.'
      ));
      continue;
    end if;

    if lower(coalesce(v_request.status, '')) = 'processed'
      or upper(coalesce(v_request.approval_status, '')) = 'PROCESSED'
    then
      if v_status = 'PAID'
        and regexp_replace(upper(btrim(coalesce(v_request.utr_cin, ''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized
      then
        v_generic_replayed := v_generic_replayed + 1;
        v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'replayed', 'message', 'This paid payment request was already recorded.'
        ));
      elsif v_status = 'CANCELLED' then
        v_generic_replayed := v_generic_replayed + 1;
        v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'replayed', 'message', 'A paid payment request is never downgraded by a later cancellation row.'
        ));
      else
        v_generic_rejected := v_generic_rejected + 1;
        v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'rejected', 'message', 'This payment request is already paid with different bank evidence.'
        ));
      end if;
      continue;
    end if;

    if lower(coalesce(v_request.status, '')) = 'returned' and v_status = 'CANCELLED' then
      v_generic_replayed := v_generic_replayed + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'replayed', 'message', 'This cancelled payment request was already returned.'
      ));
      continue;
    end if;

    if not (
      lower(coalesce(v_request.status, '')) in ('approved', 'processing')
      or upper(coalesce(v_request.status, '')) like '%\_APPROVED' escape '\'
      or upper(coalesce(v_request.approval_status, '')) in (
        'APPROVED', 'FINAL_APPROVED', 'OWNER_APPROVED', 'RE_APPROVED', 'PROCESSING'
      )
    ) then
      v_generic_rejected := v_generic_rejected + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'This payment request is not approved for bank processing.'
      ));
      continue;
    end if;

    select coalesce(max(approval.sequence_no), 0) + 1 into v_sequence
    from public.payment_request_approvals approval
    where approval.company_id = p_company_id
      and (approval.payment_request_id = v_request.id or approval.request_id = v_request.id);

    if v_status = 'PAID' then
      update public.payment_requests request
      set status = 'processed',
          approval_status = 'PROCESSED',
          utr_cin = v_utr,
          bank_status = 'Paid',
          bank_processing_remarks = nullif(v_remarks, ''),
          processing_started_at = coalesce(request.processing_started_at, clock_timestamp()),
          processed_at = clock_timestamp(),
          updated_at = clock_timestamp(),
          updated_by = p_actor_user_id
      where request.id = v_request.id and request.company_id = p_company_id;

      insert into public.payment_request_approvals(
        company_id, request_id, payment_request_id, sequence_no, role_code,
        status, action, comments, approver_user_id, approver_role_id,
        approval_cycle, created_at
      ) values (
        p_company_id, v_request.id, v_request.id, v_sequence, 'BANK',
        'processed', 'processed',
        'Processed by bank. UTR/CIN: ' || v_utr,
        p_actor_user_id, v_request.current_approver_role_id,
        coalesce(v_request.approval_cycle, 1), clock_timestamp()
      );
      v_generic_paid := v_generic_paid + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'paid', 'message', 'Payment request finalized as paid.'
      ));
      v_payment_events := v_payment_events || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_request.id,
        'request_no', v_request.request_no,
        'status', 'paid',
        'event_type', 'payment_processed',
        'remarks', coalesce(nullif(v_utr, ''), nullif(v_remarks, ''))
      ));
    else
      update public.payment_requests request
      set status = 'returned',
          approval_status = 'RETURNED',
          bank_status = 'Cancelled',
          bank_processing_remarks = nullif(v_remarks, ''),
          current_approver_user_id = null,
          current_approver_role_id = null,
          updated_at = clock_timestamp(),
          updated_by = p_actor_user_id
      where request.id = v_request.id and request.company_id = p_company_id;

      insert into public.payment_request_approvals(
        company_id, request_id, payment_request_id, sequence_no, role_code,
        status, action, comments, approver_user_id, approver_role_id,
        approval_cycle, created_at
      ) values (
        p_company_id, v_request.id, v_request.id, v_sequence, 'BANK',
        'returned', 'returned',
        'Payment Failed - ' || coalesce(nullif(v_remarks, ''), 'Cancelled by bank'),
        p_actor_user_id, v_request.current_approver_role_id,
        coalesce(v_request.approval_cycle, 1), clock_timestamp()
      );
      v_generic_cancelled := v_generic_cancelled + 1;
      v_generic_rows := v_generic_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'payment_requests', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'cancelled', 'message', 'Payment request cancelled and returned to its requester.'
      ));
      v_payment_events := v_payment_events || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_request.id,
        'request_no', v_request.request_no,
        'status', 'returned',
        'event_type', 'payment_returned',
        'remarks', 'Payment Failed - ' || coalesce(nullif(v_remarks, ''), 'Cancelled by bank')
      ));
    end if;
  end loop;

  for v_row_record in
    select response.value, response.ordinality::integer as position
    from jsonb_array_elements(p_payroll_rows)
      with ordinality response(value, ordinality)
    order by response.ordinality
  loop
    v_row := v_row_record.value;
    v_row_number := v_row_record.position;
    if coalesce(v_row ->> 'row_number', '') ~ '^[1-9][0-9]*$' then
      v_row_number := (v_row ->> 'row_number')::integer;
    end if;
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    v_debit_account := public.workforce_payout_bank_account_canonical(v_row ->> 'debit_account');
    v_account := public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account');
    v_ifsc := public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc');
    v_value_date_text := btrim(coalesce(v_row ->> 'value_date', ''));
    v_amount_paise_text := btrim(coalesce(v_row ->> 'debit_amount_paise', ''));
    v_status := upper(btrim(coalesce(v_row ->> 'status', '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr := btrim(coalesce(v_row ->> 'utr_cin', ''));
    v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
    v_remarks := btrim(coalesce(v_row ->> 'remarks', ''));

    select line.* into v_payroll_line
    from public.hr_payroll_bank_lines line
    where line.company_id = p_company_id
      and public.workforce_payout_bank_reference_canonical(line.reference) = v_reference
    for update;
    if not found then
      raise exception 'Payroll payment % no longer belongs to this company.', v_reference;
    end if;

    v_expected_account := public.workforce_payout_bank_account_canonical(v_payroll_line.credit_account);
    v_expected_ifsc := public.workforce_payout_bank_ifsc_canonical(v_payroll_line.ifsc);
    v_expected_amount_paise := round(v_payroll_line.amount * 100, 0);
    if v_amount_paise_text !~ '^[1-9][0-9]*$' then
      v_payroll_rejected := v_payroll_rejected + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Debit amount paise must be a positive integer.'
      ));
      continue;
    end if;
    v_amount_paise := v_amount_paise_text::numeric;
    if v_account !~ '^[A-Z0-9]{4,30}$'
      or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> v_expected_account
      or v_ifsc <> v_expected_ifsc
      or v_amount_paise <> v_expected_amount_paise
      or (v_debit_account <> '' and v_debit_account <>
        public.workforce_payout_bank_account_canonical(v_payroll_line.debit_account_number))
      or (v_value_date_text <> '' and (
        v_value_date_text !~ '^\d{4}-\d{2}-\d{2}$'
        or v_value_date_text::date is distinct from v_payroll_line.value_date
      ))
    then
      v_payroll_rejected := v_payroll_rejected + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Account, IFSC, value date or exact debit amount does not match the payroll instruction.'
      ));
      continue;
    end if;
    -- People Payroll intentionally mirrors its retained upload screen: PAID is
    -- successful and every other non-blank bank outcome is a failed attempt.
    if v_status = '' then
      v_payroll_rejected := v_payroll_rejected + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Bank status is required.'
      ));
      continue;
    end if;
    if v_status = 'PAID'
      and v_utr_normalized in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    then
      v_payroll_rejected := v_payroll_rejected + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'A meaningful bank UTR/CIN is required for a paid payroll instruction.'
      ));
      continue;
    end if;

    if v_payroll_line.status = 'paid' then
      if v_status <> 'PAID' then
        v_payroll_replayed := v_payroll_replayed + 1;
        v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'replayed', 'message', 'A paid payroll instruction is never downgraded by a later failed bank row.'
        ));
      elsif nullif(regexp_replace(upper(btrim(coalesce(v_payroll_line.utr, ''))), '[^A-Z0-9]', '', 'g'), '') is null then
        update public.hr_payroll_bank_lines line
        set utr = v_utr,
            bank_remarks = coalesce(nullif(v_remarks, ''), line.bank_remarks),
            updated_at = clock_timestamp()
        where line.id = v_payroll_line.id and line.company_id = p_company_id;
        v_payroll_paid := v_payroll_paid + 1;
        v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'paid', 'message', 'Paid payroll evidence was completed with the bank UTR/CIN.'
        ));
        v_payroll_run_ids := array_append(v_payroll_run_ids, v_payroll_line.run_id);
      elsif regexp_replace(upper(btrim(v_payroll_line.utr)), '[^A-Z0-9]', '', 'g') = v_utr_normalized then
        v_payroll_replayed := v_payroll_replayed + 1;
        v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'replayed', 'message', 'This paid payroll instruction was already recorded.'
        ));
      else
        v_payroll_rejected := v_payroll_rejected + 1;
        v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
          'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'rejected', 'message', 'This payroll instruction is already paid with different bank evidence.'
        ));
      end if;
      continue;
    end if;

    if v_status = 'PAID' then
      update public.hr_payroll_bank_lines line
      set status = 'paid', utr = v_utr,
          bank_remarks = coalesce(nullif(v_remarks, ''), 'Paid'),
          updated_at = clock_timestamp()
      where line.id = v_payroll_line.id and line.company_id = p_company_id;
      v_payroll_paid := v_payroll_paid + 1;
      v_payroll_run_ids := array_append(v_payroll_run_ids, v_payroll_line.run_id);
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'paid', 'message', 'Payroll payment finalized as paid.'
      ));
    elsif v_payroll_line.status in ('failed', 'returned')
      and coalesce(v_payroll_line.bank_remarks, '') = coalesce(nullif(v_remarks, ''), v_status)
    then
      v_payroll_replayed := v_payroll_replayed + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'replayed', 'message', 'This cancelled payroll instruction was already recorded.'
      ));
    else
      update public.hr_payroll_bank_lines line
      set status = 'failed', utr = null,
          bank_remarks = coalesce(nullif(v_remarks, ''), v_status),
          updated_at = clock_timestamp()
      where line.id = v_payroll_line.id and line.company_id = p_company_id;
      v_payroll_cancelled := v_payroll_cancelled + 1;
      v_payroll_result_rows := v_payroll_result_rows || jsonb_build_array(jsonb_build_object(
        'ledger', 'people_payroll', 'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'failed', 'message', 'Payroll payment was marked failed for a new payment attempt.'
      ));
    end if;
  end loop;

  select coalesce(array_agg(distinct run_id order by run_id), '{}'::uuid[])
  into v_payroll_run_ids
  from unnest(v_payroll_run_ids) run_id;
  foreach v_run_id in array v_payroll_run_ids
  loop
    perform public.hr_sync_paid_pay_documents(p_company_id, v_run_id, p_actor_user_id);
  end loop;

  v_generic_result := jsonb_build_object(
    'paid', v_generic_paid,
    'cancelled', v_generic_cancelled,
    'replayed_items', v_generic_replayed,
    'rejected', v_generic_rejected,
    'unknown', 0,
    'rows', v_generic_rows
  );
  v_payroll_result := jsonb_build_object(
    'paid', v_payroll_paid,
    'cancelled', v_payroll_cancelled,
    'failed', v_payroll_cancelled,
    'replayed_items', v_payroll_replayed,
    'rejected', v_payroll_rejected,
    'unknown', 0,
    'rows', v_payroll_result_rows,
    'run_ids', to_jsonb(v_payroll_run_ids)
  );

  select coalesce(
    jsonb_agg(combined.row_value order by combined.row_number, combined.ledger_order, combined.position),
    '[]'::jsonb
  ) into v_combined_rows
  from (
    select
      response.value || jsonb_build_object(
        'ledger', case
          when public.workforce_payout_bank_reference_canonical(response.value ->> 'reference_no') like 'HP%'
            then 'helpers'
          else 'workforce'
        end
      ) as row_value,
      case when coalesce(response.value ->> 'row_number', '') ~ '^[0-9]+$'
        then (response.value ->> 'row_number')::bigint else 9223372036854775807::bigint end as row_number,
      case when public.workforce_payout_bank_reference_canonical(response.value ->> 'reference_no') like 'HP%'
        then 1 else 0 end as ledger_order,
      response.ordinality as position
    from jsonb_array_elements(coalesce(v_payout_result -> 'rows', '[]'::jsonb))
      with ordinality response(value, ordinality)
    union all
    select response.value,
      case when coalesce(response.value ->> 'row_number', '') ~ '^[0-9]+$'
        then (response.value ->> 'row_number')::bigint else 9223372036854775807::bigint end,
      2, response.ordinality
    from jsonb_array_elements(v_generic_rows) with ordinality response(value, ordinality)
    union all
    select response.value,
      case when coalesce(response.value ->> 'row_number', '') ~ '^[0-9]+$'
        then (response.value ->> 'row_number')::bigint else 9223372036854775807::bigint end,
      3, response.ordinality
    from jsonb_array_elements(v_payroll_result_rows) with ordinality response(value, ordinality)
  ) combined;

  v_result := jsonb_build_object(
    'central_import_id', v_import_id,
    'replayed', false,
    'paid', coalesce((v_payout_result ->> 'paid')::integer, 0) + v_generic_paid + v_payroll_paid,
    'cancelled', coalesce((v_payout_result ->> 'cancelled')::integer, 0) + v_generic_cancelled + v_payroll_cancelled,
    'failed', v_payroll_cancelled,
    'replayed_items', coalesce((v_payout_result ->> 'replayed_items')::integer, 0) + v_generic_replayed + v_payroll_replayed,
    'rejected', coalesce((v_payout_result ->> 'rejected')::integer, 0) + v_generic_rejected + v_payroll_rejected,
    'unknown', coalesce((v_payout_result ->> 'unknown')::integer, 0),
    'batch_ids', coalesce(v_payout_result -> 'batch_ids', '[]'::jsonb),
    'payroll_run_ids', to_jsonb(v_payroll_run_ids),
    'payment_request_events', v_payment_events,
    'ledgers', jsonb_strip_nulls(jsonb_build_object(
      'workforce', v_payout_result -> 'ledgers' -> 'workforce',
      'helpers', v_payout_result -> 'ledgers' -> 'helpers',
      'payment_requests', case when jsonb_array_length(p_payment_request_rows) > 0 then v_generic_result end,
      'people_payroll', case when jsonb_array_length(p_payroll_rows) > 0 then v_payroll_result end
    )),
    'rows', v_combined_rows
  );

  insert into public.central_bank_response_imports(
    id, company_id, operation_id, file_sha256, file_name,
    normalized_payload_hash, normalized_payload, result_snapshot, imported_by
  ) values (
    v_import_id, p_company_id, p_operation_id, p_file_sha256, btrim(p_file_name),
    v_payload_hash, v_payload, v_result, p_actor_user_id
  );

  return v_result;
end
$function$;

comment on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) is
  'Idempotently and atomically finalizes one scoped bank response across Workforce, Helper, generic payment-request and People payroll ledgers.';

revoke all on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_central_bank_response(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
