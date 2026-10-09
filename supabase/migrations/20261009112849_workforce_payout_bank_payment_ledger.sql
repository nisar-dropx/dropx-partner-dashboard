
begin;

-- Workforce payout bank instructions are an append-first accounting ledger.
-- The mutable fields below are deliberately limited to processing -> terminal
-- transitions performed by the two service-only RPCs in this migration.
-- payment_banks is an existing application baseline installed by
-- scripts/payment_banks_v1.sql; fail clearly instead of creating a second,
-- potentially divergent copy of that master-data contract.
do $prerequisite$
begin
  if to_regclass('public.payment_banks') is null then
    raise exception 'The payment_banks baseline must be installed before the Workforce payout bank ledger.';
  end if;
  if exists (
    select required.column_name
    from (values
      ('id'), ('company_id'), ('bank_code'), ('account_no'), ('ifsc'), ('is_active')
    ) required(column_name)
    where not exists (
      select 1
      from information_schema.columns column_definition
      where column_definition.table_schema = 'public'
        and column_definition.table_name = 'payment_banks'
        and column_definition.column_name = required.column_name
    )
  ) then
    raise exception 'The payment_banks baseline does not expose the required bank configuration columns.';
  end if;
end
$prerequisite$;

-- FedOne identifiers are whitespace-insensitive but otherwise exact. Removing
-- punctuation would silently turn a mistyped account or reference into a real
-- instruction, so only formatting whitespace and invisible Unicode marks are
-- canonicalized here. The same rules are enforced by the workbook parser.
create or replace function public.workforce_payout_bank_account_canonical(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select regexp_replace(
    upper(translate(coalesce(p_value, ''), chr(160) || chr(8203) || chr(8204) || chr(8205) || chr(65279), '')),
    '[[:space:]]', '', 'g'
  );
$function$;

create or replace function public.workforce_payout_bank_ifsc_canonical(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select regexp_replace(
    upper(translate(coalesce(p_value, ''), chr(160) || chr(8203) || chr(8204) || chr(8205) || chr(65279), '')),
    '[[:space:]]', '', 'g'
  );
$function$;

create or replace function public.workforce_payout_bank_reference_canonical(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select regexp_replace(
    upper(translate(coalesce(p_value, ''), chr(160) || chr(8203) || chr(8204) || chr(8205) || chr(65279), '')),
    '[[:space:]]', '', 'g'
  );
$function$;

create unique index if not exists payment_banks_company_id_id_uidx
  on public.payment_banks (company_id, id);
create unique index if not exists workforce_payout_publications_company_id_id_uidx
  on public.workforce_payout_publications (company_id, id);

create table public.workforce_payout_payment_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  request_fingerprint text not null,
  selected_workforce_ids uuid[] not null,
  bank_id uuid not null,
  period_start date not null,
  period_end date not null,
  value_date date not null,
  debit_account_no_snapshot text not null,
  bank_code_snapshot text not null,
  file_type_snapshot text not null,
  status text not null default 'processing',
  generated_by uuid not null references auth.users(id) on delete restrict,
  generated_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint workforce_payout_payment_batches_operation_unique
    unique (company_id, operation_id),
  constraint workforce_payout_payment_batches_bank_company_fk
    foreign key (company_id, bank_id)
    references public.payment_banks(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_batches_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_payment_batches_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint workforce_payout_payment_batches_selection_check check (
    cardinality(selected_workforce_ids) between 1 and 1000
    and array_position(selected_workforce_ids, null) is null
  ),
  constraint workforce_payout_payment_batches_bank_snapshot_check check (
    debit_account_no_snapshot = public.workforce_payout_bank_account_canonical(debit_account_no_snapshot)
    and debit_account_no_snapshot ~ '^[A-Z0-9]{4,30}$'
    and nullif(btrim(bank_code_snapshot), '') is not null
    and file_type_snapshot = 'fedone'
  ),
  constraint workforce_payout_payment_batches_status_check check (
    status in ('processing', 'partially_finalized', 'completed')
  ),
  constraint workforce_payout_payment_batches_state_check check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create unique index workforce_payout_payment_batches_company_id_id_uidx
  on public.workforce_payout_payment_batches(company_id, id);
create index workforce_payout_payment_batches_company_period_idx
  on public.workforce_payout_payment_batches(company_id, period_start, period_end, generated_at desc);
create index workforce_payout_payment_batches_bank_id_idx
  on public.workforce_payout_payment_batches(bank_id);
create index workforce_payout_payment_batches_generated_by_idx
  on public.workforce_payout_payment_batches(generated_by);
create index workforce_payout_payment_batches_open_idx
  on public.workforce_payout_payment_batches(company_id, generated_at, id)
  where status in ('processing', 'partially_finalized');

create table public.workforce_payout_payment_response_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  file_sha256 text not null,
  file_name text not null,
  normalized_rows jsonb not null,
  batch_ids uuid[] not null default '{}'::uuid[],
  result_snapshot jsonb not null,
  imported_by uuid not null references auth.users(id) on delete restrict,
  imported_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_response_imports_operation_unique
    unique (company_id, operation_id),
  constraint workforce_payout_payment_response_imports_file_unique
    unique (company_id, file_sha256),
  constraint workforce_payout_payment_response_imports_sha_check check (
    file_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint workforce_payout_payment_response_imports_file_name_check check (
    nullif(btrim(file_name), '') is not null and length(file_name) <= 240
  ),
  constraint workforce_payout_payment_response_imports_rows_check check (
    jsonb_typeof(normalized_rows) = 'array'
    and jsonb_array_length(normalized_rows) between 1 and 5000
  ),
  constraint workforce_payout_payment_response_imports_batch_ids_check check (
    array_position(batch_ids, null) is null
  ),
  constraint workforce_payout_payment_response_imports_result_check check (
    jsonb_typeof(result_snapshot) = 'object'
  )
);

create unique index workforce_payout_payment_response_imports_company_id_id_uidx
  on public.workforce_payout_payment_response_imports(company_id, id);
create index workforce_payout_payment_response_imports_imported_by_idx
  on public.workforce_payout_payment_response_imports(imported_by);
create index workforce_payout_payment_response_imports_imported_at_idx
  on public.workforce_payout_payment_response_imports(company_id, imported_at desc);

create table public.workforce_payout_payment_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  batch_id uuid not null,
  workforce_id uuid not null,
  period_start date not null,
  period_end date not null,
  payment_version integer not null,
  reference_no text not null,
  dropx_id_snapshot text not null,
  beneficiary_name_snapshot text not null,
  beneficiary_email_snapshot text,
  bank_account_no_snapshot text not null,
  ifsc_snapshot text not null,
  location_id_snapshot uuid not null,
  location_code_snapshot text not null,
  debit_remarks_snapshot text not null default 'NET PAY',
  credit_remarks_snapshot text not null,
  current_target_amount numeric(14,2) not null,
  paid_before_amount numeric(14,2) not null,
  instruction_amount numeric(14,2) not null,
  status text not null default 'processing',
  bank_response_status text,
  utr_cin text,
  bank_processing_remarks text,
  response_import_id uuid,
  finalized_by uuid references auth.users(id) on delete restrict,
  finalized_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_items_batch_company_fk
    foreign key (company_id, batch_id)
    references public.workforce_payout_payment_batches(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_items_workforce_company_fk
    foreign key (company_id, workforce_id)
    references public.workforce(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_items_location_company_fk
    foreign key (company_id, location_id_snapshot)
    references public.stations(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_items_response_company_fk
    foreign key (company_id, response_import_id)
    references public.workforce_payout_payment_response_imports(company_id, id)
    on delete restrict
    deferrable initially deferred,
  constraint workforce_payout_payment_items_version_unique
    unique (company_id, workforce_id, period_start, period_end, payment_version),
  constraint workforce_payout_payment_items_reference_unique unique (company_id, reference_no),
  constraint workforce_payout_payment_items_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint workforce_payout_payment_items_version_check check (payment_version > 0),
  constraint workforce_payout_payment_items_reference_check check (
    reference_no = public.workforce_payout_bank_reference_canonical(reference_no)
    and reference_no ~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    and length(reference_no) <= 64
  ),
  constraint workforce_payout_payment_items_snapshot_check check (
    nullif(btrim(dropx_id_snapshot), '') is not null
    and nullif(btrim(beneficiary_name_snapshot), '') is not null
    and bank_account_no_snapshot = public.workforce_payout_bank_account_canonical(bank_account_no_snapshot)
    and bank_account_no_snapshot ~ '^[A-Z0-9]{4,30}$'
    and ifsc_snapshot = public.workforce_payout_bank_ifsc_canonical(ifsc_snapshot)
    and ifsc_snapshot ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    and nullif(btrim(location_code_snapshot), '') is not null
    and debit_remarks_snapshot = 'NET PAY'
    and credit_remarks_snapshot = location_code_snapshot
  ),
  constraint workforce_payout_payment_items_amount_check check (
    current_target_amount > 0
    and paid_before_amount >= 0
    and instruction_amount > 0
    and instruction_amount = current_target_amount - paid_before_amount
  ),
  constraint workforce_payout_payment_items_status_check check (
    status in ('processing', 'paid', 'cancelled')
  ),
  constraint workforce_payout_payment_items_state_check check (
    (
      status = 'processing'
      and bank_response_status is null
      and utr_cin is null
      and response_import_id is null
      and finalized_by is null
      and finalized_at is null
    )
    or (
      status = 'paid'
      and bank_response_status = 'PAID'
      and nullif(btrim(utr_cin), '') is not null
      and response_import_id is not null
      and finalized_by is not null
      and finalized_at is not null
    )
    or (
      status = 'cancelled'
      and bank_response_status = 'CANCELLED'
      and response_import_id is not null
      and finalized_by is not null
      and finalized_at is not null
    )
  )
);

create unique index workforce_payout_payment_items_active_uidx
  on public.workforce_payout_payment_items(company_id, workforce_id, period_start, period_end)
  where status = 'processing';
create unique index workforce_payout_payment_items_company_id_id_uidx
  on public.workforce_payout_payment_items(company_id, id);
create index workforce_payout_payment_items_batch_id_idx
  on public.workforce_payout_payment_items(batch_id);
create index workforce_payout_payment_items_location_id_idx
  on public.workforce_payout_payment_items(location_id_snapshot);
create index workforce_payout_payment_items_history_idx
  on public.workforce_payout_payment_items(company_id, workforce_id, period_start, period_end, payment_version desc);
create index workforce_payout_payment_items_company_processing_period_idx
  on public.workforce_payout_payment_items(company_id, period_start, period_end)
  where status = 'processing';
create index workforce_payout_payment_items_response_import_id_idx
  on public.workforce_payout_payment_items(response_import_id)
  where response_import_id is not null;
create index workforce_payout_payment_items_finalized_by_idx
  on public.workforce_payout_payment_items(finalized_by)
  where finalized_by is not null;
-- Federal Bank's UTR/CIN is the settlement identifier for a successful debit.
-- Ignore presentation characters so, for example, `UTR-001` and `utr 001`
-- cannot be recorded against two paid instructions.  Empty/placeholder values
-- are not transaction evidence and therefore do not participate in this
-- defense-in-depth uniqueness rule for legacy rows.  New paid responses reject
-- all of these placeholders below.
create unique index workforce_payout_payment_items_paid_transaction_uidx
  on public.workforce_payout_payment_items (
    company_id,
    regexp_replace(upper(btrim(coalesce(utr_cin, ''))), '[^A-Z0-9]', '', 'g')
  )
  where status = 'paid'
    and regexp_replace(upper(btrim(coalesce(utr_cin, ''))), '[^A-Z0-9]', '', 'g')
      not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE');

create table public.workforce_payout_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  payment_item_id uuid not null,
  publication_id uuid not null,
  station_id uuid not null,
  revision integer not null,
  mapping_relock_id uuid,
  snapshot_hash text not null,
  station_code_snapshot text not null,
  net_amount_snapshot numeric(14,2) not null,
  instruction_amount_snapshot numeric(14,2) not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_allocations_item_company_fk
    foreign key (company_id, payment_item_id)
    references public.workforce_payout_payment_items(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_allocations_publication_company_fk
    foreign key (company_id, publication_id)
    references public.workforce_payout_publications(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_allocations_station_company_fk
    foreign key (company_id, station_id)
    references public.stations(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_allocations_item_publication_unique
    unique (payment_item_id, publication_id),
  constraint workforce_payout_payment_allocations_revision_check check (revision > 0),
  constraint workforce_payout_payment_allocations_snapshot_check check (
    nullif(btrim(snapshot_hash), '') is not null
    and nullif(btrim(station_code_snapshot), '') is not null
    and instruction_amount_snapshot >= 0
  )
);

create index workforce_payout_payment_allocations_item_id_idx
  on public.workforce_payout_payment_allocations(payment_item_id);
create index workforce_payout_payment_allocations_publication_id_idx
  on public.workforce_payout_payment_allocations(publication_id);
create index workforce_payout_payment_allocations_station_id_idx
  on public.workforce_payout_payment_allocations(station_id);
create index workforce_payout_payment_allocations_mapping_relock_id_idx
  on public.workforce_payout_payment_allocations(mapping_relock_id)
  where mapping_relock_id is not null;

create table public.workforce_payout_payment_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  batch_id uuid,
  payment_item_id uuid,
  response_import_id uuid,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_payment_events_batch_company_fk
    foreign key (company_id, batch_id)
    references public.workforce_payout_payment_batches(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_events_item_company_fk
    foreign key (company_id, payment_item_id)
    references public.workforce_payout_payment_items(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_events_response_company_fk
    foreign key (company_id, response_import_id)
    references public.workforce_payout_payment_response_imports(company_id, id)
    on delete restrict,
  constraint workforce_payout_payment_events_type_check check (
    nullif(btrim(event_type), '') is not null and length(event_type) <= 80
  ),
  constraint workforce_payout_payment_events_data_check check (
    jsonb_typeof(event_data) = 'object'
  ),
  constraint workforce_payout_payment_events_subject_check check (
    batch_id is not null or payment_item_id is not null or response_import_id is not null
  )
);

create index workforce_payout_payment_events_batch_id_idx
  on public.workforce_payout_payment_events(batch_id)
  where batch_id is not null;
create index workforce_payout_payment_events_item_id_idx
  on public.workforce_payout_payment_events(payment_item_id)
  where payment_item_id is not null;
create index workforce_payout_payment_events_response_id_idx
  on public.workforce_payout_payment_events(response_import_id)
  where response_import_id is not null;
create index workforce_payout_payment_events_actor_idx
  on public.workforce_payout_payment_events(actor_user_id);

alter table public.workforce_payout_payment_batches enable row level security;
alter table public.workforce_payout_payment_batches force row level security;
alter table public.workforce_payout_payment_items enable row level security;
alter table public.workforce_payout_payment_items force row level security;
alter table public.workforce_payout_payment_allocations enable row level security;
alter table public.workforce_payout_payment_allocations force row level security;
alter table public.workforce_payout_payment_response_imports enable row level security;
alter table public.workforce_payout_payment_response_imports force row level security;
alter table public.workforce_payout_payment_events enable row level security;
alter table public.workforce_payout_payment_events force row level security;

revoke all on table public.workforce_payout_payment_batches,
  public.workforce_payout_payment_items,
  public.workforce_payout_payment_allocations,
  public.workforce_payout_payment_response_imports,
  public.workforce_payout_payment_events
  from public, anon, authenticated, service_role;
grant select on table public.workforce_payout_payment_batches,
  public.workforce_payout_payment_items,
  public.workforce_payout_payment_allocations,
  public.workforce_payout_payment_response_imports,
  public.workforce_payout_payment_events
  to service_role;

create policy workforce_payout_payment_batches_service_select
  on public.workforce_payout_payment_batches for select to service_role using (true);
create policy workforce_payout_payment_items_service_select
  on public.workforce_payout_payment_items for select to service_role using (true);
create policy workforce_payout_payment_allocations_service_select
  on public.workforce_payout_payment_allocations for select to service_role using (true);
create policy workforce_payout_payment_response_imports_service_select
  on public.workforce_payout_payment_response_imports for select to service_role using (true);
create policy workforce_payout_payment_events_service_select
  on public.workforce_payout_payment_events for select to service_role using (true);

comment on table public.workforce_payout_payment_batches is
  'Immutable bank-file generation envelope; only its derived processing status may transition inside the service RPC.';
comment on table public.workforce_payout_payment_items is
  'Versioned Workforce/month payment instructions. Paid attempts reduce later instructions; cancelled attempts still consume their version.';
comment on table public.workforce_payout_payment_allocations is
  'Immutable evidence linking one payment instruction to every latest visible station publication included in its target amount.';
comment on table public.workforce_payout_payment_response_imports is
  'Immutable, file-hash-idempotent bank response import with its normalized rows and result snapshot.';
comment on table public.workforce_payout_payment_events is
  'Append-only audit events for Workforce payout bank processing.';

create or replace function public.guard_workforce_payout_payment_batch_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment batches may be changed only by the bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Workforce payout payment batches cannot be deleted.';
  end if;
  if tg_op = 'INSERT' then return new; end if;

  if (to_jsonb(new) - array['status', 'updated_at', 'completed_at']::text[])
    is distinct from
    (to_jsonb(old) - array['status', 'updated_at', 'completed_at']::text[])
  then
    raise exception 'A Workforce payout payment batch is immutable after generation.';
  end if;
  if old.status = 'completed' then
    raise exception 'A completed Workforce payout payment batch is immutable.';
  end if;
  if old.status = 'processing' and new.status not in ('processing', 'partially_finalized', 'completed') then
    raise exception 'Invalid Workforce payout payment batch transition.';
  end if;
  if old.status = 'partially_finalized' and new.status not in ('partially_finalized', 'completed') then
    raise exception 'Invalid Workforce payout payment batch transition.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_payment_batches_00_ledger_guard
before insert or update or delete on public.workforce_payout_payment_batches
for each row execute function public.guard_workforce_payout_payment_batch_ledger();

create or replace function public.guard_workforce_payout_payment_item_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment items may be changed only by the bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Workforce payout payment items cannot be deleted.';
  end if;
  if tg_op = 'INSERT' then return new; end if;

  if (to_jsonb(new) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
    is distinct from
    (to_jsonb(old) - array[
      'status', 'bank_response_status', 'utr_cin', 'bank_processing_remarks',
      'response_import_id', 'finalized_by', 'finalized_at', 'updated_at'
    ]::text[])
  then
    raise exception 'A Workforce payout payment instruction is immutable after generation.';
  end if;
  if old.status <> 'processing' or new.status not in ('paid', 'cancelled') then
    raise exception 'A terminal Workforce payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_payment_items_00_ledger_guard
before insert or update or delete on public.workforce_payout_payment_items
for each row execute function public.guard_workforce_payout_payment_item_ledger();

create or replace function public.guard_workforce_payout_payment_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Workforce payout payment audit rows may be appended only by the bank-processing RPCs.';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Workforce payout payment audit rows are immutable.';
  end if;
  return new;
end
$function$;

create trigger workforce_payout_payment_allocations_00_append_only
before insert or update or delete on public.workforce_payout_payment_allocations
for each row execute function public.guard_workforce_payout_payment_append_only();
create trigger workforce_payout_payment_response_imports_00_append_only
before insert or update or delete on public.workforce_payout_payment_response_imports
for each row execute function public.guard_workforce_payout_payment_append_only();
create trigger workforce_payout_payment_events_00_append_only
before insert or update or delete on public.workforce_payout_payment_events
for each row execute function public.guard_workforce_payout_payment_append_only();

create or replace function public.workforce_payout_payment_reference(
  p_dropx_id text,
  p_period_start date,
  p_version integer
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_normalized_id text := regexp_replace(upper(btrim(coalesce(p_dropx_id, ''))), '[^A-Z0-9]', '', 'g');
  v_reference text;
begin
  if v_normalized_id = '' then
    raise exception 'DropX ID is required for a Workforce payment reference.';
  end if;
  if p_period_start is null or extract(day from p_period_start) <> 1 then
    raise exception 'A calendar-month start is required for a Workforce payment reference.';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'A positive Workforce payment version is required.';
  end if;
  v_reference := 'WP' || v_normalized_id
    || lpad(extract(month from p_period_start)::integer::text, 2, '0')
    || extract(year from p_period_start)::integer::text
    || 'V' || p_version::text;
  if length(v_reference) > 64 then
    raise exception 'DropX ID is too long for the bank reference format.';
  end if;
  if v_reference !~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$' then
    raise exception 'The Workforce payment reference could not be generated in the required bank format.';
  end if;
  return v_reference;
end
$function$;

create or replace function public.workforce_payout_payment_is_processing(
  p_company_id uuid,
  p_workforce_id uuid,
  p_period_start date,
  p_period_end date
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $function$
  select exists (
    select 1
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = p_workforce_id
      and item.status = 'processing'
      and daterange(item.period_start, item.period_end, '[]')
        && daterange(p_period_start, coalesce(p_period_end, 'infinity'::date), '[]')
  );
$function$;

create or replace function public.workforce_payout_payment_interval_is_processing(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $function$
  select exists (
    select 1
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.status = 'processing'
      and item.period_end >= p_effective_from
      and (p_effective_until is null or item.period_start < p_effective_until)
  );
$function$;

create or replace function public.workforce_assert_payout_not_processing(
  p_company_id uuid,
  p_workforce_id uuid,
  p_period_start date,
  p_period_end date
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_company_id is null or p_workforce_id is null or p_period_start is null then
    return;
  end if;
  if public.workforce_payout_payment_is_processing(
    p_company_id,
    p_workforce_id,
    p_period_start,
    coalesce(p_period_end, 'infinity'::date)
  ) then
    raise exception 'Payment Processing is active for this Workforce ID and payout month. Payout inputs can be changed after the bank response is finalized.';
  end if;
end
$function$;

-- All payout-source writers use the canonical Workforce row and the existing
-- company mutex in the same order as payment generation/finalization. The
-- second old/new scope prevents an UPDATE from moving a row out of a locked
-- identity or period while its bank instruction is outstanding.
create or replace function public.guard_workforce_payout_source_during_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_old_company uuid;
  v_old_workforce uuid;
  v_old_start date;
  v_old_end date;
  v_new_company uuid;
  v_new_workforce uuid;
  v_new_start date;
  v_new_end date;
  v_company uuid;
begin
  if tg_table_name = 'workforce_payout_publications'
    and coalesce(v_new ->> 'publication_kind', v_old ->> 'publication_kind') <> 'worksheet'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if v_old is not null then
    v_old_company := nullif(v_old ->> tg_argv[0], '')::uuid;
    v_old_workforce := nullif(v_old ->> tg_argv[1], '')::uuid;
    v_old_start := nullif(v_old ->> tg_argv[2], '')::date;
    v_old_end := coalesce(
      nullif(v_old ->> tg_argv[3], '')::date,
      case
        when tg_nargs > 4 and tg_argv[4] = 'null_is_infinity'
          then 'infinity'::date
        else v_old_start
      end
    );
  end if;
  if v_new is not null then
    v_new_company := nullif(v_new ->> tg_argv[0], '')::uuid;
    v_new_workforce := nullif(v_new ->> tg_argv[1], '')::uuid;
    v_new_start := nullif(v_new ->> tg_argv[2], '')::date;
    v_new_end := coalesce(
      nullif(v_new ->> tg_argv[3], '')::date,
      case
        when tg_nargs > 4 and tg_argv[4] = 'null_is_infinity'
          then 'infinity'::date
        else v_new_start
      end
    );
  end if;

  perform 1
  from public.workforce workforce
  join (
    select distinct scope.company_id, scope.workforce_id
    from (values
      (v_old_company, v_old_workforce),
      (v_new_company, v_new_workforce)
    ) scope(company_id, workforce_id)
    where scope.company_id is not null and scope.workforce_id is not null
  ) scope
    on scope.company_id = workforce.company_id
   and scope.workforce_id = workforce.id
  order by workforce.company_id, workforce.id
  for update of workforce;

  for v_company in
    select distinct scope.company_id
    from (values (v_old_company), (v_new_company)) scope(company_id)
    where scope.company_id is not null
    order by scope.company_id
  loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;

  perform public.workforce_assert_payout_not_processing(
    v_old_company, v_old_workforce, v_old_start, v_old_end
  );
  if (v_new_company, v_new_workforce, v_new_start, v_new_end)
    is distinct from
    (v_old_company, v_old_workforce, v_old_start, v_old_end)
  then
    perform public.workforce_assert_payout_not_processing(
      v_new_company, v_new_workforce, v_new_start, v_new_end
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger workforce_payout_attendance_overrides_00_bank_processing_guard
before insert or update or delete on public.workforce_payout_attendance_overrides
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'work_date', 'work_date'
);
create trigger workforce_custom_production_inputs_00_bank_processing_guard
before insert or update or delete on public.workforce_custom_production_inputs
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'work_date', 'work_date'
);
create trigger workforce_payment_field_overrides_00_bank_processing_guard
before insert or update or delete on public.workforce_payment_field_overrides
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'effective_from', 'effective_to'
);
create trigger workforce_additional_payment_values_00_bank_processing_guard
before insert or update or delete on public.workforce_additional_payment_values
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'effective_from', 'effective_to'
);
create trigger workforce_payout_deduction_values_00_bank_processing_guard
before insert or update or delete on public.workforce_payout_deduction_values
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'effective_from', 'effective_to'
);
create trigger workforce_payout_attendance_values_00_bank_processing_guard
before insert or update or delete on public.workforce_payout_attendance_values
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'effective_from', 'effective_to'
);
create trigger workforce_payment_allocations_00_bank_processing_guard
before insert or update or delete on public.workforce_payment_allocations
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'effective_from', 'effective_to', 'null_is_infinity'
);
create trigger workforce_payout_mapping_unlocks_00_bank_processing_guard
before insert on public.workforce_payout_mapping_unlocks
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'period_start', 'period_end'
);
create trigger workforce_payout_publications_00_bank_processing_guard
before insert on public.workforce_payout_publications
for each row execute function public.guard_workforce_payout_source_during_bank_processing(
  'company_id', 'workforce_id', 'period_start', 'period_end'
);

-- Provider mappings may point at legacy people records rather than carrying a
-- Workforce UUID. Resolve both OLD and NEW identities before taking locks so a
-- cross-person/cross-company move cannot escape the processing-period guard.
create or replace function public.guard_workforce_provider_mapping_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_company uuid;
  v_old_workforce uuid;
  v_old_start date;
  v_old_end date;
  v_new_company uuid;
  v_new_workforce uuid;
  v_new_start date;
  v_new_end date;
  v_company uuid;
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(old) - 'updated_at') is not distinct from (to_jsonb(new) - 'updated_at')
  then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    v_old_company := old.company_id;
    v_old_workforce := public.workforce_provider_mapping_person(
      old.company_id,
      old.workforce_id,
      old.field_executive_id,
      old.employee_id,
      old.contractor_id
    );
    if lower(coalesce(old.status, '')) <> 'cancelled' then
      v_old_start := old.effective_from;
      v_old_end := coalesce(old.effective_to, 'infinity'::date);
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_company := new.company_id;
    v_new_workforce := public.workforce_provider_mapping_person(
      new.company_id,
      new.workforce_id,
      new.field_executive_id,
      new.employee_id,
      new.contractor_id
    );
    if lower(coalesce(new.status, '')) <> 'cancelled' then
      v_new_start := new.effective_from;
      v_new_end := coalesce(new.effective_to, 'infinity'::date);
    end if;
  end if;

  perform 1
  from public.workforce workforce
  join (
    select distinct scope.company_id, scope.workforce_id
    from (values
      (v_old_company, v_old_workforce),
      (v_new_company, v_new_workforce)
    ) scope(company_id, workforce_id)
    where scope.company_id is not null and scope.workforce_id is not null
  ) scope
    on scope.company_id = workforce.company_id
   and scope.workforce_id = workforce.id
  order by workforce.company_id, workforce.id
  for update of workforce;

  for v_company in
    select distinct scope.company_id
    from (values (v_old_company), (v_new_company)) scope(company_id)
    where scope.company_id is not null
    order by scope.company_id
  loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;

  perform public.workforce_assert_payout_not_processing(
    v_old_company, v_old_workforce, v_old_start, v_old_end
  );
  if (v_new_company, v_new_workforce, v_new_start, v_new_end)
    is distinct from
    (v_old_company, v_old_workforce, v_old_start, v_old_end)
  then
    perform public.workforce_assert_payout_not_processing(
      v_new_company, v_new_workforce, v_new_start, v_new_end
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger field_executive_provider_mappings_00_published_processing_guard
before insert or update or delete on public.field_executive_provider_mappings
for each row execute function public.guard_workforce_provider_mapping_bank_processing();

-- Review rows are already locked by the time their row trigger runs. Current
-- writers take Workforce -> company locks before reaching this trigger and
-- direct service-role UPDATE is revoked, so this guard deliberately performs
-- only the authoritative overlap check and never inverts that lock order.
create or replace function public.guard_workforce_payout_review_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_company uuid;
  v_old_workforce uuid;
  v_old_start date;
  v_old_end date;
  v_new_company uuid;
  v_new_workforce uuid;
  v_new_start date;
  v_new_end date;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.subject_type = 'workforce' then
    v_old_company := old.company_id;
    v_old_workforce := old.subject_id;
    v_old_start := old.period_start;
    v_old_end := old.period_end;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.subject_type = 'workforce' then
    v_new_company := new.company_id;
    v_new_workforce := new.subject_id;
    v_new_start := new.period_start;
    v_new_end := new.period_end;
  end if;

  if tg_op = 'UPDATE'
    and new.status is not distinct from old.status
    and new.calculation_snapshot is not distinct from old.calculation_snapshot
    and (v_new_company, v_new_workforce, v_new_start, v_new_end)
      is not distinct from
      (v_old_company, v_old_workforce, v_old_start, v_old_end)
  then
    return new;
  end if;

  perform public.workforce_assert_payout_not_processing(
    v_old_company, v_old_workforce, v_old_start, v_old_end
  );
  if (v_new_company, v_new_workforce, v_new_start, v_new_end)
    is distinct from
    (v_old_company, v_old_workforce, v_old_start, v_old_end)
  then
    perform public.workforce_assert_payout_not_processing(
      v_new_company, v_new_workforce, v_new_start, v_new_end
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger workforce_payout_review_submissions_00_bank_processing_guard
before insert or update or delete on public.workforce_payout_review_submissions
for each row execute function public.guard_workforce_payout_review_bank_processing();

-- Review mutations are routed through the lock-ordered SECURITY DEFINER RPCs.
-- Removing direct service writes makes the query-only row assertion above an
-- atomic backstop without ever taking a Workforce lock below a review row lock.
revoke insert, update, delete, truncate
  on table public.workforce_payout_review_submissions
  from service_role;

-- A relock may legitimately remove every publication for one impacted person,
-- so guarding publication INSERT alone is not sufficient. The relock envelope
-- freezes the complete expanded source/current-owner identity set.
create or replace function public.guard_workforce_payout_mapping_relock_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workforce_id uuid;
begin
  perform 1
  from public.workforce workforce
  where workforce.company_id = new.company_id
    and workforce.id = any(new.affected_workforce_ids)
  order by workforce.id
  for update;
  perform public.lock_workforce_payment_allocation_company(new.company_id);

  for v_workforce_id in
    select distinct affected_id
    from unnest(new.affected_workforce_ids) affected_id
    order by affected_id
  loop
    perform public.workforce_assert_payout_not_processing(
      new.company_id, v_workforce_id, new.period_start, new.period_end
    );
  end loop;
  return new;
end
$function$;

create trigger workforce_payout_mapping_relocks_00_bank_processing_guard
before insert on public.workforce_payout_mapping_relocks
for each row execute function public.guard_workforce_payout_mapping_relock_bank_processing();

-- Effective-dated company policy is global to Workforce payouts. Any one
-- processing instruction therefore freezes the overlapping company interval.
create or replace function public.workforce_attendance_capture_interval_is_locked(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('review', 'approved', 'paid')
      and payroll_run.period_end >= p_effective_from
      and (p_effective_until is null or payroll_run.period_start < p_effective_until)

    union all

    select 1
    from public.workforce_payout_review_submissions review_submission
    where review_submission.company_id = p_company_id
      and review_submission.subject_type = 'workforce'
      and lower(coalesce(review_submission.status, '')) in ('under_review', 'approved')
      and review_submission.period_end >= p_effective_from
      and (p_effective_until is null or review_submission.period_start < p_effective_until)

    union all

    select 1
    from public.workforce_payout_payment_items payment_item
    where payment_item.company_id = p_company_id
      and payment_item.status = 'processing'
      and payment_item.period_end >= p_effective_from
      and (p_effective_until is null or payment_item.period_start < p_effective_until)
  );
$function$;

create or replace function public.assert_workforce_payment_policy_interval_open(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
      and payroll_run.period_end >= p_effective_from
      and (p_effective_until is null or payroll_run.period_start < p_effective_until)
  ) or public.workforce_payout_payment_interval_is_processing(
    p_company_id, p_effective_from, p_effective_until
  ) then
    raise exception 'Workforce payment policy cannot change because a finalized or processing payout depends on its effective period.';
  end if;
end
$function$;

create or replace function public.guard_workforce_payment_setting_insert_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_effective_until date;
begin
  perform public.lock_workforce_payment_allocation_company(new.company_id);
  select min(setting.effective_from)
  into v_effective_until
  from public.workforce_payment_settings setting
  where setting.company_id = new.company_id
    and setting.effective_from > new.effective_from;
  if public.workforce_payout_payment_interval_is_processing(
    new.company_id, new.effective_from, v_effective_until
  ) then
    raise exception 'Workforce payment policy cannot change while a bank payment for the effective period is processing.';
  end if;
  return new;
end
$function$;

create trigger workforce_payment_settings_00_bank_processing_insert
before insert on public.workforce_payment_settings
for each row execute function public.guard_workforce_payment_setting_insert_bank_processing();

create or replace function public.guard_workforce_attendance_setting_insert_bank_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_effective_until date;
begin
  perform public.lock_workforce_payment_allocation_company(new.company_id);
  select min(setting.effective_from)
  into v_effective_until
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = new.company_id
    and setting.effective_from > new.effective_from;
  if public.workforce_payout_payment_interval_is_processing(
    new.company_id, new.effective_from, v_effective_until
  ) then
    raise exception 'Attendance capture cannot change while a bank payment for the effective period is processing.';
  end if;
  return new;
end
$function$;

create trigger workforce_attendance_capture_settings_00_bank_processing_insert
before insert on public.workforce_attendance_capture_settings
for each row execute function public.guard_workforce_attendance_setting_insert_bank_processing();

-- These established service RPCs already acquire canonical person locks and
-- the company payout mutex in the required order. Inject a friendly assertion
-- immediately after that mutex; the row triggers above remain the final atomic
-- backstop if a future writer bypasses one of these APIs.
do $patch$
declare
  v_definition text;
  v_marker text := 'perform public.lock_workforce_payment_allocation_company(p_company_id);';
  v_position integer;
begin
  select pg_get_functiondef(
    'public.workforce_apply_advance_recoveries(uuid,uuid,date,date,jsonb,uuid[])'::regprocedure
  ) into v_definition;
  v_position := strpos(v_definition, v_marker);
  if v_position = 0 then
    raise exception 'Could not install the bank-processing assertion in workforce_apply_advance_recoveries.';
  end if;
  v_definition := overlay(
    v_definition placing E'\n\n  perform public.workforce_assert_payout_not_processing(\n    p_company_id, selected.workforce_id, p_period_start, p_period_end\n  )\n  from (\n    select distinct (item ->> ''workforce_id'')::uuid as workforce_id\n    from jsonb_array_elements(p_items) item\n  ) selected;'
    from v_position + length(v_marker) for 0
  );
  execute v_definition;
end
$patch$;

do $patch$
declare
  v_definition text;
  v_marker text := 'perform public.lock_workforce_payment_allocation_company(p_company_id);';
  v_position integer;
begin
  select pg_get_functiondef(
    'public.payment_recovery_configure_case(uuid,uuid,text,date,text[],jsonb,uuid,uuid[])'::regprocedure
  ) into v_definition;
  v_position := strpos(v_definition, v_marker);
  if v_position = 0 then
    raise exception 'Could not install the bank-processing assertion in payment_recovery_configure_case.';
  end if;
  v_definition := overlay(
    v_definition placing E'\n\n  perform public.workforce_assert_payout_not_processing(\n    p_company_id, selected.workforce_id, p_payout_month, v_period_end\n  )\n  from (\n    select distinct candidate.workforce_id\n    from pg_catalog.unnest(v_normalized_ids) requested(dropx_id)\n    cross join lateral public.payment_recovery_eligible_payout_targets(\n      p_company_id, p_payout_month, p_allowed_location_ids\n    ) candidate\n    where candidate.dropx_id = requested.dropx_id\n      and candidate.payout_engine = ''workforce''\n      and candidate.workforce_id is not null\n  ) selected;'
    from v_position + length(v_marker) for 0
  );
  execute v_definition;
end
$patch$;

do $patch$
declare
  v_definition text;
  v_marker text := 'perform public.lock_workforce_payment_allocation_company(p_company_id);';
  v_position integer;
begin
  select pg_get_functiondef(
    'public.workforce_relock_payout_mappings(uuid,uuid,date,date,uuid[],uuid,text,text,jsonb)'::regprocedure
  ) into v_definition;
  v_position := strpos(v_definition, v_marker);
  if v_position = 0 then
    raise exception 'Could not install the bank-processing assertion in workforce_relock_payout_mappings.';
  end if;
  v_definition := overlay(
    v_definition placing E'\n\n  perform public.workforce_assert_payout_not_processing(\n    p_company_id, impacted.workforce_id, p_period_start, p_period_end\n  )\n  from (\n    select distinct workforce_id\n    from unnest(v_impacted_ids) workforce_id\n  ) impacted;'
    from v_position + length(v_marker) for 0
  );
  execute v_definition;
end
$patch$;

do $patch$
declare
  v_definition text;
  v_marker text := 'perform public.lock_workforce_payment_allocation_company(p_company_id);';
  v_position integer;
begin
  select pg_get_functiondef(
    'public.workforce_transition_payout_review_status(uuid,text,uuid,uuid,date,date,text,text,uuid[])'::regprocedure
  ) into v_definition;
  v_position := strpos(v_definition, v_marker);
  if v_position = 0 then
    raise exception 'Could not install the bank-processing assertion in workforce_transition_payout_review_status.';
  end if;
  v_definition := overlay(
    v_definition placing E'\n\n  if v_subject_type = ''workforce'' then\n    perform public.workforce_assert_payout_not_processing(\n      p_company_id, p_subject_id, p_period_start, p_period_end\n    );\n  end if;'
    from v_position + length(v_marker) for 0
  );
  execute v_definition;
end
$patch$;

-- One canonical, read-only candidate calculation feeds both the dashboard
-- preview and the mutating batch creator. Keeping required locations, latest
-- publication selection, dependency freshness, paid totals and bank readiness
-- here prevents the UI from advertising an amount the create RPC would reject
-- or paying a different amount from the one the operator reviewed.
create or replace function public.workforce_payout_payment_candidates(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_workforce_ids uuid[]
)
returns table (
  workforce_id uuid,
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
  eligibility_message text,
  required_publication_count integer,
  eligible_publication_count integer,
  publications jsonb,
  location_id uuid,
  location_code text
)
language plpgsql
security invoker
set search_path = ''
stable
as $function$
declare
  v_ids uuid[];
  v_workforce_id uuid;
  v_worker public.workforce%rowtype;
  v_current_dependency_hash text;
  v_target numeric(14,2);
  v_paid numeric(14,2);
  v_processing numeric(14,2);
  v_processing_target numeric(14,2);
  v_history_count integer;
  v_required_count integer;
  v_eligible_count integer;
  v_publications jsonb;
  v_location_id uuid;
  v_location_code text;
begin
  if p_company_id is null then
    raise exception 'Company is required for a Workforce payment preview.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Workforce bank payment preview requires one exact calendar month.';
  end if;

  select coalesce(array_agg(selected.id order by selected.id), '{}'::uuid[])
  into v_ids
  from (
    select distinct id
    from unnest(coalesce(p_workforce_ids, '{}'::uuid[])) id
    where id is not null
  ) selected;
  if cardinality(v_ids) > 1000 then
    raise exception 'Preview at most 1000 Workforce IDs at a time.';
  end if;
  if cardinality(v_ids) = 0 then
    return;
  end if;

  v_current_dependency_hash := public.workforce_advance_recovery_snapshot_hash(
    p_company_id, p_period_start, p_period_end
  );
  if nullif(btrim(coalesce(v_current_dependency_hash, '')), '') is null then
    raise exception 'The current Workforce payout dependency version is unavailable.';
  end if;

  foreach v_workforce_id in array v_ids
  loop
    workforce_id := v_workforce_id;
    dropx_id := null;
    current_target_amount := 0;
    paid_amount := 0;
    processing_amount := 0;
    balance_payable := 0;
    available_to_pay := 0;
    history_count := 0;
    payment_status := null;
    eligible := false;
    eligibility_code := null;
    eligibility_message := null;
    required_publication_count := 0;
    eligible_publication_count := 0;
    publications := '[]'::jsonb;
    location_id := null;
    location_code := null;

    select worker.*
    into v_worker
    from public.workforce worker
    where worker.company_id = p_company_id
      and worker.id = v_workforce_id;
    if not found then
      eligibility_code := 'profile_unavailable';
      eligibility_message := format(
        'Workforce profile %s is unavailable in this company.',
        v_workforce_id::text
      );
      return next;
      continue;
    end if;
    dropx_id := nullif(upper(btrim(coalesce(v_worker.dropx_id, ''))), '');

    select
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0), 2),
      round(coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0), 2),
      round(coalesce(max(item.current_target_amount) filter (where item.status = 'processing'), 0), 2),
      count(*)::integer
    into v_paid, v_processing, v_processing_target, v_history_count
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    paid_amount := v_paid;
    processing_amount := v_processing;
    history_count := v_history_count;

    -- While processing, the immutable item target is the only safe preview.
    -- Source inputs are intentionally unavailable for editing until a terminal
    -- response, so the dashboard must not replace this with a live-row total.
    if v_processing > 0 then
      current_target_amount := greatest(v_processing_target, 0::numeric);
      balance_payable := greatest(round(current_target_amount - v_paid, 2), 0::numeric);
      available_to_pay := 0;
      payment_status := 'Payment Processing';
      eligibility_code := 'payment_processing';
      eligibility_message := format(
        'One or more selected Workforce IDs already have a Payment Processing instruction for this month (including %s).',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if exists (
      select 1
      from public.workforce_payout_publication_refresh_jobs job
      where job.company_id = p_company_id
        and job.workforce_id = v_workforce_id
        and job.period_start = p_period_start
        and job.period_end = p_period_end
        and job.status <> 'completed'
    ) then
      eligibility_code := 'publication_refresh_pending';
      eligibility_message := format(
        'Workforce ID %s still has an unfinished publication refresh. Retry after it completes.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if exists (
      select 1
      from public.workforce_payout_mapping_revision_state(
        p_company_id, v_workforce_id
      ) revision
      where revision.period_start = p_period_start
        and revision.period_end = p_period_end
        and revision.revision_pending
    ) then
      eligibility_code := 'mapping_relock_required';
      eligibility_message := format(
        'Relock Workforce ID %s mapping for this month before creating its bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    with latest_relock as (
      select relock.id, relock.active_locations
      from public.workforce_payout_mapping_relocks relock
      where relock.company_id = p_company_id
        and relock.period_start = p_period_start
        and relock.period_end = p_period_end
        and relock.affected_workforce_ids @> array[v_workforce_id]::uuid[]
      order by relock.relocked_at desc, relock.id desc
      limit 1
    ), required_stations as (
      select distinct required.station_id
      from (
        select station_text::uuid as station_id
        from latest_relock
        cross join lateral jsonb_array_elements_text(
          coalesce(
            latest_relock.active_locations -> (v_workforce_id::text),
            '[]'::jsonb
          )
        ) station_value(station_text)
        union all
        select review_submission.location_id
        from public.workforce_payout_review_submissions review_submission
        where review_submission.company_id = p_company_id
          and review_submission.subject_type = 'workforce'
          and review_submission.subject_id = v_workforce_id
          and review_submission.period_start = p_period_start
          and review_submission.period_end = p_period_end
          and not exists (select 1 from latest_relock)
      ) required
    ), candidate_publications as (
      select publication.*, review_submission.status as review_status
      from public.workforce_payout_publications publication
      join required_stations required_station
        on required_station.station_id = publication.station_id
      join public.workforce_payout_review_submissions review_submission
        on review_submission.company_id = publication.company_id
       and review_submission.id = publication.review_submission_id
       and review_submission.subject_type = 'workforce'
       and review_submission.subject_id = publication.workforce_id
       and review_submission.location_id = publication.station_id
       and review_submission.period_start = publication.period_start
       and review_submission.period_end = publication.period_end
      where publication.company_id = p_company_id
        and publication.workforce_id = v_workforce_id
        and publication.publication_kind = 'worksheet'
        and publication.period_start = p_period_start
        and publication.period_end = p_period_end
        and (
          not exists (select 1 from latest_relock)
          or publication.mapping_relock_id = (select id from latest_relock)
        )
    ), latest as (
      select distinct on (publication.station_id) publication.*
      from candidate_publications publication
      order by publication.station_id, publication.revision desc,
        publication.published_at desc, publication.id desc
    )
    select
      count(*)::integer,
      count(*) filter (where
        latest.snapshot ->> 'schema_version' = '2'
        and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
        and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
        and (
          latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
          or (
            latest.snapshot #> '{worksheet,payment_eligible}' is null
            and latest.snapshot #> '{worksheet,payment_details_available}' is null
            and latest.snapshot #> '{worksheet,payment_status}' is null
            and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
          )
        )
        and latest.review_status in ('under_review', 'approved')
        and latest.dependency_hash = v_current_dependency_hash
        and latest.snapshot -> 'item' ->> 'net_amount' ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
        and nullif(btrim(coalesce(latest.snapshot -> 'item' ->> 'station_code', station.station_code, '')), '') is not null
      )::integer,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'publication_id', latest.id,
          'station_id', latest.station_id,
          'revision', latest.revision,
          'mapping_relock_id', latest.mapping_relock_id,
          'snapshot_hash', latest.snapshot_hash,
          'station_code', coalesce(latest.snapshot -> 'item' ->> 'station_code', station.station_code),
          'net_amount', round((latest.snapshot -> 'item' ->> 'net_amount')::numeric, 2)
        )
        order by latest.station_id
      ) filter (where
        latest.snapshot ->> 'schema_version' = '2'
        and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
        and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
        and (
          latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
          or (
            latest.snapshot #> '{worksheet,payment_eligible}' is null
            and latest.snapshot #> '{worksheet,payment_details_available}' is null
            and latest.snapshot #> '{worksheet,payment_status}' is null
            and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
          )
        )
        and latest.review_status in ('under_review', 'approved')
        and latest.dependency_hash = v_current_dependency_hash
        and latest.snapshot -> 'item' ->> 'net_amount' ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
        and nullif(btrim(coalesce(latest.snapshot -> 'item' ->> 'station_code', station.station_code, '')), '') is not null
      ), '[]'::jsonb),
      round(coalesce(sum((latest.snapshot -> 'item' ->> 'net_amount')::numeric) filter (where
        latest.snapshot ->> 'schema_version' = '2'
        and latest.snapshot ->> 'source' = 'workforce_payout_worksheet'
        and latest.snapshot -> 'item' ->> 'workforce_id' = v_workforce_id::text
        and (
          latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
          or (
            latest.snapshot #> '{worksheet,payment_eligible}' is null
            and latest.snapshot #> '{worksheet,payment_details_available}' is null
            and latest.snapshot #> '{worksheet,payment_status}' is null
            and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
          )
        )
        and latest.review_status in ('under_review', 'approved')
        and latest.dependency_hash = v_current_dependency_hash
        and latest.snapshot -> 'item' ->> 'net_amount' ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        and nullif(btrim(coalesce(latest.snapshot_hash, '')), '') is not null
        and nullif(btrim(coalesce(latest.snapshot -> 'item' ->> 'station_code', station.station_code, '')), '') is not null
      ), 0), 2)
    into v_required_count, v_eligible_count, v_publications, v_target
    from required_stations required_station
    left join latest
      on latest.station_id = required_station.station_id
    left join public.stations station
      on station.company_id = p_company_id
     and station.id = required_station.station_id;

    required_publication_count := v_required_count;
    eligible_publication_count := v_eligible_count;
    publications := v_publications;

    if v_required_count < 1 then
      eligibility_code := 'publication_missing';
      eligibility_message := format(
        'No current published payout is available for Workforce ID %s in this month.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;
    if v_eligible_count <> v_required_count then
      eligibility_code := 'publication_stale_or_incomplete';
      eligibility_message := format(
        'A current published payout is stale, incomplete, or not explicitly payment-eligible for Workforce ID %s. Republish or relock it before creating a bank payment.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    current_target_amount := greatest(v_target, 0::numeric);
    balance_payable := greatest(round(current_target_amount - v_paid, 2), 0::numeric);
    available_to_pay := balance_payable;
    payment_status := case
      when v_paid > 0 and balance_payable = 0 then 'Paid'
      when v_paid > 0 then 'Partially paid'
      else null
    end;
    if available_to_pay <= 0 then
      eligibility_code := 'no_positive_balance';
      eligibility_message := format(
        'Workforce ID %s has no positive balance payable for this month.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;

    if dropx_id is null
      or nullif(btrim(coalesce(v_worker.full_name, '')), '') is null
      or nullif(btrim(coalesce(v_worker.bank_account_no, '')), '') is null
      or nullif(btrim(coalesce(v_worker.ifsc_code, '')), '') is null
    then
      eligibility_code := 'beneficiary_bank_details_missing';
      eligibility_message := format(
        'DropX ID, beneficiary name, bank account and IFSC are required for Workforce ID %s.',
        coalesce(dropx_id, v_workforce_id::text)
      );
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_account_canonical(v_worker.bank_account_no)
      !~ '^[A-Z0-9]{4,30}$'
    then
      eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format(
        'Bank account for Workforce ID %s must contain 4 to 30 letters or digits.',
        dropx_id
      );
      return next;
      continue;
    end if;
    if public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code)
      !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    then
      eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format(
        'IFSC for Workforce ID %s must use the standard 11-character format.',
        dropx_id
      );
      return next;
      continue;
    end if;
    if regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g') = ''
      or 9
        + length(regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g'))
        + length((v_history_count + 1)::text) > 64
    then
      eligibility_code := 'payment_reference_invalid';
      eligibility_message := format(
        'DropX ID %s cannot produce a valid Workforce bank reference.',
        dropx_id
      );
      return next;
      continue;
    end if;

    select station.id, upper(btrim(station.station_code))
    into v_location_id, v_location_code
    from public.stations station
    where station.company_id = p_company_id
      and station.id = v_worker.location_id
      and nullif(btrim(station.station_code), '') is not null;
    if not found then
      eligibility_code := 'current_location_missing';
      eligibility_message := format(
        'A current company location is required for Workforce ID %s bank remarks.',
        dropx_id
      );
      return next;
      continue;
    end if;

    location_id := v_location_id;
    location_code := v_location_code;
    eligible := true;
    eligibility_code := 'eligible';
    eligibility_message := '';
    return next;
  end loop;
end
$function$;

create or replace function public.workforce_preview_payout_payments(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_workforce_ids uuid[]
)
returns table (
  workforce_id uuid,
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
set search_path = ''
stable
as $function$
  select
    candidate.workforce_id,
    candidate.dropx_id,
    candidate.current_target_amount,
    candidate.paid_amount,
    candidate.processing_amount,
    candidate.balance_payable,
    candidate.available_to_pay,
    candidate.history_count,
    candidate.payment_status,
    candidate.eligible,
    candidate.eligibility_code,
    candidate.eligibility_message
  from public.workforce_payout_payment_candidates(
    p_company_id, p_period_start, p_period_end, p_workforce_ids
  ) candidate
  order by candidate.workforce_id;
$function$;

create or replace function public.workforce_payout_payment_batch_result(
  p_batch_id uuid,
  p_replayed boolean
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $function$
  select jsonb_build_object(
    'batch_id', batch.id,
    'replayed', p_replayed,
    'status', batch.status,
    'period_start', batch.period_start,
    'period_end', batch.period_end,
    'value_date', batch.value_date,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'item_id', item.id,
          'workforce_id', item.workforce_id,
          'dropx_id', item.dropx_id_snapshot,
          'payment_version', item.payment_version,
          'reference_no', item.reference_no,
          'status', item.status,
          'instruction_amount', item.instruction_amount,
          'current_target_amount', item.current_target_amount,
          'paid_before_amount', item.paid_before_amount,
          'bank_account_no', item.bank_account_no_snapshot,
          'ifsc', item.ifsc_snapshot,
          'beneficiary_name', item.beneficiary_name_snapshot,
          'beneficiary_email', coalesce(item.beneficiary_email_snapshot, ''),
          'credit_remarks', item.credit_remarks_snapshot,
          'debit_remarks', item.debit_remarks_snapshot,
          'debit_account_no', batch.debit_account_no_snapshot,
          'value_date', batch.value_date,
          'bank_id', batch.bank_id,
          'file_type', batch.file_type_snapshot
        )
        order by item.dropx_id_snapshot, item.reference_no
      )
      from public.workforce_payout_payment_items item
      where item.batch_id = batch.id
    ), '[]'::jsonb)
  )
  from public.workforce_payout_payment_batches batch
  where batch.id = p_batch_id;
$function$;

create or replace function public.workforce_create_payout_payment_batch(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_request_fingerprint text,
  p_bank_id uuid,
  p_period_start date,
  p_period_end date,
  p_value_date date,
  p_workforce_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_ids uuid[];
  v_existing public.workforce_payout_payment_batches%rowtype;
  v_bank public.payment_banks%rowtype;
  v_worker public.workforce%rowtype;
  v_candidate record;
  v_debit_account text;
  v_bank_ifsc text;
  v_beneficiary_account text;
  v_beneficiary_ifsc text;
  v_workforce_id uuid;
  v_location_id uuid;
  v_location_code text;
  v_publications jsonb;
  v_target numeric(14,2);
  v_paid numeric(14,2);
  v_instruction numeric(14,2);
  v_version integer;
  v_reference text;
  v_item_id uuid;
  v_batch_id uuid := gen_random_uuid();
  v_created_count integer := 0;
  v_preflight_count integer := 0;
  v_locked_count integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null or p_bank_id is null then
    raise exception 'Company, actor, operation and bank are required for a Workforce payment batch.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Workforce bank payment generation requires one exact calendar month.';
  end if;
  if p_value_date is null then
    raise exception 'Bank value date is required.';
  end if;
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 request fingerprint is required.';
  end if;

  select coalesce(array_agg(selected.id order by selected.id), '{}'::uuid[])
  into v_ids
  from (
    select distinct id
    from unnest(coalesce(p_workforce_ids, '{}'::uuid[])) id
    where id is not null
  ) selected;
  if cardinality(v_ids) < 1 or cardinality(v_ids) > 1000 then
    raise exception 'Select between 1 and 1000 Workforce IDs for one bank file.';
  end if;

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;
  select batch.* into v_existing
  from public.workforce_payout_payment_batches batch
  where batch.company_id = p_company_id
    and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_workforce_ids <> v_ids
      or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date
      or v_existing.generated_by <> p_actor_user_id
    then
      raise exception 'This Workforce payment operation ID was already used for a different request.';
    end if;
  end if;

  -- Stable lock order shared with all payout-input interlocks.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id = any(v_ids)
  order by workforce.id
  for update;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> cardinality(v_ids) then
    raise exception 'One or more selected Workforce profiles are unavailable in this company.';
  end if;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  -- Close the operation-ID race only after the canonical lock set is held.
  select batch.* into v_existing
  from public.workforce_payout_payment_batches batch
  where batch.company_id = p_company_id
    and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_workforce_ids <> v_ids
      or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date
      or v_existing.generated_by <> p_actor_user_id
    then
      raise exception 'This Workforce payment operation ID was already used for a different request.';
    end if;
    if v_existing.status <> 'processing'
      or exists (
        select 1
        from public.workforce_payout_payment_items item
        where item.company_id = p_company_id
          and item.batch_id = v_existing.id
          and item.status <> 'processing'
      )
    then
      raise exception 'This Workforce payment batch is already partially or fully finalized and its bank file cannot be regenerated.';
    end if;
    return public.workforce_payout_payment_batch_result(v_existing.id, true);
  end if;

  select bank.*
  into v_bank
  from public.payment_banks bank
  where bank.company_id = p_company_id
    and bank.id = p_bank_id
    and bank.is_active = true
    and upper(btrim(bank.bank_code)) = 'FEDERAL_BANK'
  for share;
  if not found then
    raise exception 'Select the active Federal Bank FedOne payment bank configured for this company.';
  end if;

  -- Fail closed before inserting the batch/item rows which make the month
  -- Payment Processing. Whitespace is formatting; punctuation is not silently
  -- discarded because that could redirect a payment to a different account.
  v_debit_account := public.workforce_payout_bank_account_canonical(v_bank.account_no);
  v_bank_ifsc := public.workforce_payout_bank_ifsc_canonical(v_bank.ifsc);
  if v_debit_account !~ '^[A-Z0-9]{4,30}$' then
    raise exception 'The selected Federal Bank debit account must contain 4 to 30 letters or digits.';
  end if;
  if v_bank_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The selected Federal Bank IFSC must use the standard 11-character format.';
  end if;

  for v_candidate in
    select candidate.*
    from public.workforce_payout_payment_candidates(
      p_company_id, p_period_start, p_period_end, v_ids
    ) candidate
    order by candidate.workforce_id
  loop
    if not coalesce(v_candidate.eligible, false) then
      if v_candidate.eligibility_code = 'no_positive_balance' then
        continue;
      end if;
      raise exception '%', v_candidate.eligibility_message;
    end if;
    v_preflight_count := v_preflight_count + 1;
  end loop;
  if v_preflight_count < 1 then
    raise exception 'The selected Workforce IDs have no positive balance payable for this month.';
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  insert into public.workforce_payout_payment_batches (
    id, company_id, operation_id, request_fingerprint,
    selected_workforce_ids, bank_id, period_start, period_end,
    value_date, debit_account_no_snapshot, bank_code_snapshot,
    file_type_snapshot, status, generated_by
  ) values (
    v_batch_id, p_company_id, p_operation_id, p_request_fingerprint,
    v_ids, p_bank_id, p_period_start, p_period_end,
    p_value_date, v_debit_account, upper(btrim(v_bank.bank_code)),
    'fedone', 'processing', p_actor_user_id
  );

  for v_candidate in
    select candidate.*
    from public.workforce_payout_payment_candidates(
      p_company_id, p_period_start, p_period_end, v_ids
    ) candidate
    order by candidate.workforce_id
  loop
    v_workforce_id := v_candidate.workforce_id;
    select workforce.* into v_worker
    from public.workforce workforce
    where workforce.company_id = p_company_id
      and workforce.id = v_workforce_id;

    if not coalesce(v_candidate.eligible, false) then
      if v_candidate.eligibility_code = 'no_positive_balance' then
        continue;
      end if;
      raise exception '%', v_candidate.eligibility_message;
    end if;

    v_publications := v_candidate.publications;
    v_target := v_candidate.current_target_amount;
    v_paid := v_candidate.paid_amount;
    v_instruction := v_candidate.available_to_pay;
    v_location_id := v_candidate.location_id;
    v_location_code := v_candidate.location_code;
    v_beneficiary_account := public.workforce_payout_bank_account_canonical(v_worker.bank_account_no);
    v_beneficiary_ifsc := public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code);

    select coalesce(max(item.payment_version), 0) + 1
    into v_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;
    v_reference := public.workforce_payout_payment_reference(
      v_worker.dropx_id,
      p_period_start,
      v_version
    );

    insert into public.workforce_payout_payment_items (
      company_id, batch_id, workforce_id, period_start, period_end,
      payment_version, reference_no, dropx_id_snapshot,
      beneficiary_name_snapshot, beneficiary_email_snapshot,
      bank_account_no_snapshot, ifsc_snapshot,
      location_id_snapshot, location_code_snapshot,
      debit_remarks_snapshot, credit_remarks_snapshot,
      current_target_amount, paid_before_amount, instruction_amount,
      status
    ) values (
      p_company_id, v_batch_id, v_workforce_id, p_period_start, p_period_end,
      v_version, v_reference, upper(btrim(v_worker.dropx_id)),
      btrim(v_worker.full_name), nullif(btrim(coalesce(v_worker.email, '')), ''),
      v_beneficiary_account, v_beneficiary_ifsc,
      v_location_id, v_location_code,
      'NET PAY', v_location_code,
      v_target, v_paid, v_instruction,
      'processing'
    ) returning id into v_item_id;

    -- Allocate the item instruction to station evidence in exact cents. Positive
    -- station net amounts are the weights; stable remainder distribution makes
    -- the allocation sum equal the item instruction without duplicate totals.
    insert into public.workforce_payout_payment_allocations (
      company_id, payment_item_id, publication_id, station_id, revision,
      mapping_relock_id, snapshot_hash, station_code_snapshot,
      net_amount_snapshot, instruction_amount_snapshot
    )
    with source_rows as (
      select
        (publication ->> 'publication_id')::uuid as publication_id,
        (publication ->> 'station_id')::uuid as station_id,
        (publication ->> 'revision')::integer as revision,
        nullif(publication ->> 'mapping_relock_id', '')::uuid as mapping_relock_id,
        publication ->> 'snapshot_hash' as snapshot_hash,
        publication ->> 'station_code' as station_code,
        (publication ->> 'net_amount')::numeric(14,2) as net_amount,
        greatest((publication ->> 'net_amount')::numeric, 0) as weight
      from jsonb_array_elements(v_publications) publication
    ), weighted as (
      select source_rows.*,
        sum(weight) over () as total_weight,
        row_number() over (
          order by case when weight > 0 then 0 else 1 end, station_id, publication_id
        ) as allocation_rank
      from source_rows
    ), floored as (
      select weighted.*,
        floor(
          round(v_instruction * 100, 0)
          * weight / nullif(total_weight, 0)
        ) as base_cents
      from weighted
    ), allocated as (
      select floored.*,
        round(v_instruction * 100, 0) - sum(base_cents) over () as remaining_cents
      from floored
    )
    select
      p_company_id,
      v_item_id,
      allocated.publication_id,
      allocated.station_id,
      allocated.revision,
      allocated.mapping_relock_id,
      allocated.snapshot_hash,
      allocated.station_code,
      allocated.net_amount,
      (
        allocated.base_cents
        + case when allocated.allocation_rank <= allocated.remaining_cents then 1 else 0 end
      ) / 100
    from allocated;

    insert into public.workforce_payout_payment_events (
      company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
    ) values (
      p_company_id, v_batch_id, v_item_id, 'payment_instruction_created',
      jsonb_build_object(
        'reference_no', v_reference,
        'payment_version', v_version,
        'current_target_amount', v_target,
        'paid_before_amount', v_paid,
        'instruction_amount', v_instruction
      ),
      p_actor_user_id
    );
    v_created_count := v_created_count + 1;
  end loop;

  if v_created_count < 1 then
    raise exception 'The selected Workforce IDs have no positive balance payable for this month.';
  end if;
  insert into public.workforce_payout_payment_events (
    company_id, batch_id, event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_batch_id, 'bank_file_generated',
    jsonb_build_object(
      'payment_count', v_created_count,
      'value_date', p_value_date,
      'bank_id', p_bank_id
    ),
    p_actor_user_id
  );

  return public.workforce_payout_payment_batch_result(v_batch_id, false);
end
$function$;

create or replace function public.workforce_finalize_payout_payment_response(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_file_sha256 text,
  p_file_name text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.workforce_payout_payment_response_imports%rowtype;
  v_import_id uuid := gen_random_uuid();
  v_row_record record;
  v_row jsonb;
  v_row_number integer;
  v_reference text;
  v_account text;
  v_ifsc text;
  v_amount_paise_text text;
  v_amount_paise numeric;
  v_status text;
  v_utr text;
  v_utr_normalized text;
  v_remarks text;
  v_item public.workforce_payout_payment_items%rowtype;
  v_batch_id uuid;
  v_batch_status text;
  v_processing_count integer;
  v_terminal_count integer;
  v_batch_ids uuid[] := '{}'::uuid[];
  v_locked_count integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_paid_count integer := 0;
  v_cancelled_count integer := 0;
  v_replayed_count integer := 0;
  v_rejected_count integer := 0;
  v_unknown_count integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required for a Workforce bank response.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 bank response file hash is required.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid bank response file name is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 5000
  then
    raise exception 'Bank response must contain between 1 and 5000 normalized rows.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  select imported.* into v_existing
  from public.workforce_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.operation_id = p_operation_id;
  if found then
    if v_existing.file_sha256 <> p_file_sha256
      or v_existing.normalized_rows is distinct from p_rows
    then
      raise exception 'This bank response operation ID was already used for a different file or normalized payload.';
    end if;
    return v_existing.result_snapshot
      || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;
  select imported.* into v_existing
  from public.workforce_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.file_sha256 = p_file_sha256;
  if found then
    if v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This bank response file hash was already recorded with a different normalized payload.';
    end if;
    return v_existing.result_snapshot
      || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;

  if exists (
    select 1
    from (
      select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no') reference_no
      from jsonb_array_elements(p_rows) row(value)
    ) normalized
    where normalized.reference_no <> ''
    group by normalized.reference_no
    having count(*) > 1
  ) then
    raise exception 'The bank response contains the same customer reference more than once.';
  end if;

  -- Lock every matching person in deterministic order before taking the shared
  -- company mutex. Unknown references remain reportable without widening scope.
  perform 1
  from public.workforce workforce
  where workforce.company_id = p_company_id
    and workforce.id in (
      select distinct item.workforce_id
      from public.workforce_payout_payment_items item
      join (
        select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no') reference_no
        from jsonb_array_elements(p_rows) row(value)
      ) response on response.reference_no = item.reference_no
      where item.company_id = p_company_id
    )
  order by workforce.id
  for update;
  get diagnostics v_locked_count = row_count;
  perform public.lock_workforce_payment_allocation_company(p_company_id);

  perform 1
  from public.workforce_payout_payment_items item
  where item.company_id = p_company_id
    and item.reference_no in (
      select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no')
      from jsonb_array_elements(p_rows) row(value)
    )
  order by item.workforce_id, item.period_start, item.payment_version, item.id
  for update;

  -- Close operation/file-hash races under the company mutex.
  select imported.* into v_existing
  from public.workforce_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.operation_id = p_operation_id;
  if found then
    if v_existing.file_sha256 <> p_file_sha256
      or v_existing.normalized_rows is distinct from p_rows
    then
      raise exception 'This bank response operation ID was already used for a different file or normalized payload.';
    end if;
    return v_existing.result_snapshot
      || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;
  select imported.* into v_existing
  from public.workforce_payout_payment_response_imports imported
  where imported.company_id = p_company_id
    and imported.file_sha256 = p_file_sha256;
  if found then
    if v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This bank response file hash was already recorded with a different normalized payload.';
    end if;
    return v_existing.result_snapshot
      || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;

  perform set_config('app.workforce_payout_payment_mutation', 'allowed', true);
  for v_row_record in
    select response.value, response.ordinality::integer as row_number
    from jsonb_array_elements(p_rows) with ordinality response(value, ordinality)
    order by response.ordinality
  loop
    v_row := v_row_record.value;
    v_row_number := v_row_record.row_number;
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

    if v_reference = '' then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', '',
        'outcome', 'rejected',
        'message', 'Customer reference is required.'
      ));
      continue;
    end if;
    if length(v_reference) > 64
      or v_reference !~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'Customer reference is not a valid Workforce payment reference.'
      ));
      continue;
    end if;

    select item.* into v_item
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.reference_no = v_reference;
    if not found then
      v_unknown_count := v_unknown_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'unknown',
        'message', 'No Workforce payment instruction matches this reference.'
      ));
      continue;
    end if;
    v_batch_ids := array_append(v_batch_ids, v_item.batch_id);

    if v_amount_paise_text !~ '^[1-9][0-9]*$' then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'Debit amount paise must be a positive integer.'
      ));
      continue;
    end if;
    v_amount_paise := v_amount_paise_text::numeric;
    if v_account !~ '^[A-Z0-9]{4,30}$'
      or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise <> round(v_item.instruction_amount * 100, 0)
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'Account, IFSC or exact debit amount does not match the generated instruction.'
      ));
      continue;
    end if;
    if v_status not in ('PAID', 'CANCELLED') then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'Status must be PAID or CANCELLED.'
      ));
      continue;
    end if;
    if v_status = 'PAID' and v_utr = '' then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'UTR/CIN is required for a paid instruction.'
      ));
      continue;
    end if;
    if v_status = 'PAID'
      and v_utr_normalized in (
        '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
      )
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'A meaningful bank UTR/CIN is required for a paid instruction; placeholder values are not accepted.'
      ));
      continue;
    end if;

    -- A meaningful bank transaction identifier is evidence of one successful
    -- debit only.  The company mutex taken above makes this friendly check
    -- race-safe; the partial unique index remains the final integrity boundary
    -- for any future write path.  Excluding this item preserves idempotent
    -- re-import of its normalized-equivalent terminal response.
    if v_status = 'PAID'
      and v_utr_normalized not in (
        '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
      )
      and exists (
        select 1
        from public.workforce_payout_payment_items paid_item
        where paid_item.company_id = p_company_id
          and paid_item.status = 'paid'
          and paid_item.id <> v_item.id
          and regexp_replace(
            upper(btrim(coalesce(paid_item.utr_cin, ''))),
            '[^A-Z0-9]', '', 'g'
          ) = v_utr_normalized
      )
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', 'This UTR/CIN is already recorded for another paid Workforce instruction.'
      ));
      continue;
    end if;

    if v_item.status <> 'processing' then
      if v_item.bank_response_status = v_status
        and regexp_replace(
          upper(btrim(coalesce(v_item.utr_cin, ''))),
          '[^A-Z0-9]', '', 'g'
        ) = v_utr_normalized
        and btrim(coalesce(v_item.bank_processing_remarks, '')) = v_remarks
      then
        v_replayed_count := v_replayed_count + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number,
          'reference_no', v_reference,
          'outcome', 'replayed',
          'message', 'This exact terminal response was already recorded.'
        ));
      else
        v_rejected_count := v_rejected_count + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number,
          'reference_no', v_reference,
          'outcome', 'rejected',
          'message', 'This payment is already terminal with a different bank response.'
        ));
      end if;
      continue;
    end if;

    update public.workforce_payout_payment_items item
    set status = case when v_status = 'PAID' then 'paid' else 'cancelled' end,
        bank_response_status = v_status,
        utr_cin = nullif(v_utr, ''),
        bank_processing_remarks = nullif(v_remarks, ''),
        response_import_id = v_import_id,
        finalized_by = p_actor_user_id,
        finalized_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where item.id = v_item.id;

    if v_status = 'PAID' then
      v_paid_count := v_paid_count + 1;
    else
      v_cancelled_count := v_cancelled_count + 1;
    end if;
    insert into public.workforce_payout_payment_events (
      company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
    ) values (
      p_company_id, v_item.batch_id, v_item.id,
      case when v_status = 'PAID' then 'payment_paid' else 'payment_cancelled' end,
      jsonb_build_object(
        'response_import_id', v_import_id,
        'reference_no', v_reference,
        'utr_cin', nullif(v_utr, ''),
        'processing_remarks', nullif(v_remarks, '')
      ),
      p_actor_user_id
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row_number', v_row_number,
      'reference_no', v_reference,
      'outcome', lower(v_status),
      'message', case when v_status = 'PAID'
        then 'Payment finalized as paid.' else 'Payment cancelled and unlocked for a new version.' end
    ));
  end loop;

  select coalesce(array_agg(distinct batch_id order by batch_id), '{}'::uuid[])
  into v_batch_ids
  from unnest(v_batch_ids) batch_id;

  foreach v_batch_id in array v_batch_ids
  loop
    select
      count(*) filter (where item.status = 'processing')::integer,
      count(*) filter (where item.status in ('paid', 'cancelled'))::integer
    into v_processing_count, v_terminal_count
    from public.workforce_payout_payment_items item
    where item.batch_id = v_batch_id;
    v_batch_status := case
      when v_processing_count = 0 then 'completed'
      when v_terminal_count > 0 then 'partially_finalized'
      else 'processing'
    end;
    update public.workforce_payout_payment_batches batch
    set status = v_batch_status,
        updated_at = clock_timestamp(),
        completed_at = case when v_batch_status = 'completed'
          then coalesce(batch.completed_at, clock_timestamp()) else null end
    where batch.id = v_batch_id
      and (
        batch.status <> v_batch_status
        or (v_batch_status = 'completed' and batch.completed_at is null)
      );
  end loop;

  v_result := jsonb_build_object(
    'response_import_id', v_import_id,
    'replayed', false,
    'paid', v_paid_count,
    'cancelled', v_cancelled_count,
    'replayed_items', v_replayed_count,
    'rejected', v_rejected_count,
    'unknown', v_unknown_count,
    'batch_ids', to_jsonb(v_batch_ids),
    'rows', v_results
  );
  insert into public.workforce_payout_payment_response_imports (
    id, company_id, operation_id, file_sha256, file_name,
    normalized_rows, batch_ids, result_snapshot, imported_by
  ) values (
    v_import_id, p_company_id, p_operation_id, p_file_sha256, btrim(p_file_name),
    p_rows, v_batch_ids, v_result, p_actor_user_id
  );
  insert into public.workforce_payout_payment_events (
    company_id, response_import_id, event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_import_id, 'bank_response_imported',
    jsonb_build_object(
      'paid', v_paid_count,
      'cancelled', v_cancelled_count,
      'replayed_items', v_replayed_count,
      'rejected', v_rejected_count,
      'unknown', v_unknown_count,
      'batch_ids', to_jsonb(v_batch_ids)
    ),
    p_actor_user_id
  );
  return v_result;
end
$function$;

comment on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) is
  'Atomically freezes one versioned FedOne instruction per selected Workforce/month positive balance and places that payout in Payment Processing.';
comment on function public.workforce_preview_payout_payments(uuid, date, date, uuid[]) is
  'Returns the exact canonical balance and eligibility that the Workforce bank batch creator will use, without changing payment state.';
comment on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[]) is
  'Internal canonical Workforce payment candidate calculation shared by read-only preview and bank batch creation.';
comment on function public.workforce_finalize_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb
) is
  'Idempotently validates exact FedOne response identity/amount fields and transitions matching Workforce payment instructions to paid or cancelled.';
comment on function public.workforce_payout_payment_is_processing(uuid, uuid, date, date) is
  'Returns whether an overlapping Workforce payout bank instruction remains in Payment Processing.';
comment on function public.workforce_payout_payment_interval_is_processing(uuid, date, date) is
  'Returns whether any Workforce bank payment is processing in an overlapping company policy interval.';
comment on function public.workforce_assert_payout_not_processing(uuid, uuid, date, date) is
  'Database interlock used by every payout-input and mapping/publication writer while a bank instruction is processing.';

revoke all on function public.guard_workforce_payout_payment_batch_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payout_payment_item_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payout_payment_append_only()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_bank_account_canonical(text)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_bank_ifsc_canonical(text)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_bank_reference_canonical(text)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_reference(text, date, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_is_processing(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_interval_is_processing(uuid, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_assert_payout_not_processing(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payout_source_during_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_provider_mapping_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payout_review_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payout_mapping_relock_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_payment_setting_insert_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_workforce_attendance_setting_insert_bank_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_batch_result(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.workforce_preview_payout_payments(uuid, date, date, uuid[])
  from public, anon, authenticated;
revoke all on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) from public, anon, authenticated;
revoke all on function public.workforce_finalize_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.workforce_create_payout_payment_batch(
  uuid, uuid, uuid, text, uuid, date, date, date, uuid[]
) to service_role;
grant execute on function public.workforce_preview_payout_payments(
  uuid, date, date, uuid[]
) to service_role;
grant execute on function public.workforce_finalize_payout_payment_response(
  uuid, uuid, uuid, text, text, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
