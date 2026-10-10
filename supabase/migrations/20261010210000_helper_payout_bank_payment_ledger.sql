begin;

-- Helper bank payments intentionally use a separate immutable ledger. This
-- keeps every existing Workforce constraint, lock and reference namespace
-- unchanged while giving Helper payouts the same operational lifecycle.
create extension if not exists pgcrypto;

create or replace function public.helper_payout_bank_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select btrim(regexp_replace(
    replace(replace(replace(replace(coalesce(p_value, ''), chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), ''),
    '[[:space:]]+', ' ', 'g'
  ));
$function$;

create table public.helper_payout_payment_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  request_fingerprint text not null,
  selected_helper_ids uuid[] not null,
  bank_id uuid not null,
  period_start date not null,
  period_end date not null,
  value_date date not null,
  debit_account_no_snapshot text not null,
  bank_code_snapshot text not null,
  file_type_snapshot text not null default 'fedone',
  status text not null default 'processing',
  generated_by uuid not null references auth.users(id) on delete restrict,
  generated_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint helper_payout_payment_batches_operation_unique unique (company_id, operation_id),
  constraint helper_payout_payment_batches_bank_company_fk
    foreign key (company_id, bank_id) references public.payment_banks(company_id, id) on delete restrict,
  constraint helper_payout_payment_batches_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint helper_payout_payment_batches_value_date_check check (
    value_date between date '1900-01-01' and date '9999-12-31'
  ),
  constraint helper_payout_payment_batches_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint helper_payout_payment_batches_selection_check check (
    cardinality(selected_helper_ids) >= 1 and array_position(selected_helper_ids, null) is null
  ),
  constraint helper_payout_payment_batches_bank_snapshot_check check (
    debit_account_no_snapshot = public.workforce_payout_bank_account_canonical(debit_account_no_snapshot)
    and debit_account_no_snapshot ~ '^[A-Z0-9]{4,30}$'
    and nullif(btrim(bank_code_snapshot), '') is not null
    and file_type_snapshot = 'fedone'
  ),
  constraint helper_payout_payment_batches_status_check
    check (status in ('processing', 'partially_finalized', 'completed')),
  constraint helper_payout_payment_batches_state_check check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create unique index helper_payout_payment_batches_company_id_id_uidx
  on public.helper_payout_payment_batches(company_id, id);
create index helper_payout_payment_batches_company_period_idx
  on public.helper_payout_payment_batches(company_id, period_start, period_end, generated_at desc);
create index helper_payout_payment_batches_open_idx
  on public.helper_payout_payment_batches(company_id, generated_at, id)
  where status in ('processing', 'partially_finalized');

create table public.helper_payout_payment_response_imports (
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
  constraint helper_payout_payment_response_operation_unique unique (company_id, operation_id),
  constraint helper_payout_payment_response_file_unique unique (company_id, file_sha256),
  constraint helper_payout_payment_response_sha_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint helper_payout_payment_response_file_name_check
    check (nullif(btrim(file_name), '') is not null and length(file_name) <= 240),
  constraint helper_payout_payment_response_rows_check check (
    jsonb_typeof(normalized_rows) = 'array'
    and jsonb_array_length(normalized_rows) between 1 and 5000
  ),
  constraint helper_payout_payment_response_result_check check (jsonb_typeof(result_snapshot) = 'object')
);

create unique index helper_payout_payment_response_company_id_id_uidx
  on public.helper_payout_payment_response_imports(company_id, id);

create table public.helper_payout_payment_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  batch_id uuid not null,
  helper_id uuid not null,
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
  helper_publication_id uuid not null,
  target_snapshot_hash text not null,
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
  constraint helper_payout_payment_items_batch_company_fk
    foreign key (company_id, batch_id)
    references public.helper_payout_payment_batches(company_id, id) on delete restrict,
  constraint helper_payout_payment_items_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers(company_id, id) on delete restrict,
  constraint helper_payout_payment_items_location_company_fk
    foreign key (company_id, location_id_snapshot) references public.stations(company_id, id) on delete restrict,
  constraint helper_payout_payment_items_publication_company_fk
    foreign key (company_id, helper_publication_id)
    references public.helper_payout_publications(company_id, id) on delete restrict,
  constraint helper_payout_payment_items_response_company_fk
    foreign key (company_id, response_import_id)
    references public.helper_payout_payment_response_imports(company_id, id)
    on delete restrict deferrable initially deferred,
  constraint helper_payout_payment_items_version_unique
    unique (company_id, helper_id, period_start, period_end, payment_version),
  constraint helper_payout_payment_items_reference_unique unique (company_id, reference_no),
  constraint helper_payout_payment_items_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint helper_payout_payment_items_version_check check (payment_version > 0),
  constraint helper_payout_payment_items_reference_check check (
    reference_no = public.workforce_payout_bank_reference_canonical(reference_no)
    and reference_no ~ '^HP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    and length(reference_no) <= 64
  ),
  constraint helper_payout_payment_items_snapshot_check check (
    nullif(btrim(dropx_id_snapshot), '') is not null
    and nullif(public.helper_payout_bank_text(beneficiary_name_snapshot), '') is not null
    and bank_account_no_snapshot = public.workforce_payout_bank_account_canonical(bank_account_no_snapshot)
    and bank_account_no_snapshot ~ '^[A-Z0-9]{4,30}$'
    and ifsc_snapshot = public.workforce_payout_bank_ifsc_canonical(ifsc_snapshot)
    and ifsc_snapshot ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    and nullif(public.helper_payout_bank_text(location_code_snapshot), '') is not null
    and target_snapshot_hash ~ '^[0-9a-f]{64}$'
    and debit_remarks_snapshot = 'NET PAY'
    and credit_remarks_snapshot = location_code_snapshot
  ),
  constraint helper_payout_payment_items_amount_check check (
    current_target_amount > 0 and paid_before_amount >= 0 and instruction_amount > 0
    and instruction_amount = current_target_amount - paid_before_amount
  ),
  constraint helper_payout_payment_items_status_check
    check (status in ('processing', 'paid', 'cancelled', 'failed')),
  constraint helper_payout_payment_items_state_check check (
    (status = 'processing' and bank_response_status is null and utr_cin is null
      and response_import_id is null and finalized_by is null and finalized_at is null)
    or (status = 'paid' and bank_response_status = 'PAID'
      and nullif(btrim(utr_cin), '') is not null and response_import_id is not null
      and finalized_by is not null and finalized_at is not null)
    or (status = 'cancelled' and finalized_by is not null and finalized_at is not null
      and ((bank_response_status = 'CANCELLED' and response_import_id is not null)
        or (bank_response_status = 'MANUAL_CANCELLED' and response_import_id is null
          and utr_cin is null and nullif(btrim(bank_processing_remarks), '') is not null)))
    or (status = 'failed' and bank_response_status = 'MANUAL_FAILED'
      and response_import_id is null and utr_cin is null
      and nullif(btrim(bank_processing_remarks), '') is not null
      and finalized_by is not null and finalized_at is not null)
  )
);

create unique index helper_payout_payment_items_processing_uidx
  on public.helper_payout_payment_items(company_id, helper_id, location_id_snapshot, period_start, period_end)
  where status = 'processing';
create unique index helper_payout_payment_items_company_id_id_uidx
  on public.helper_payout_payment_items(company_id, id);
create index helper_payout_payment_items_history_idx
  on public.helper_payout_payment_items(
    company_id, helper_id, location_id_snapshot, period_start, period_end, payment_version desc
  );
create unique index helper_payout_payment_items_paid_transaction_uidx
  on public.helper_payout_payment_items(
    company_id, regexp_replace(upper(btrim(coalesce(utr_cin, ''))), '[^A-Z0-9]', '', 'g')
  )
  where status = 'paid'
    and regexp_replace(upper(btrim(coalesce(utr_cin, ''))), '[^A-Z0-9]', '', 'g')
      not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE');

create table public.helper_payout_payment_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  batch_id uuid,
  payment_item_id uuid,
  response_import_id uuid,
  operation_id uuid,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint helper_payout_payment_events_batch_company_fk
    foreign key (company_id, batch_id)
    references public.helper_payout_payment_batches(company_id, id) on delete restrict,
  constraint helper_payout_payment_events_item_company_fk
    foreign key (company_id, payment_item_id)
    references public.helper_payout_payment_items(company_id, id) on delete restrict,
  constraint helper_payout_payment_events_response_company_fk
    foreign key (company_id, response_import_id)
    references public.helper_payout_payment_response_imports(company_id, id) on delete restrict,
  constraint helper_payout_payment_events_subject_check
    check (batch_id is not null or payment_item_id is not null or response_import_id is not null),
  constraint helper_payout_payment_events_data_check check (jsonb_typeof(event_data) = 'object')
);

create unique index helper_payout_payment_events_operation_uidx
  on public.helper_payout_payment_events(company_id, operation_id) where operation_id is not null;
create index helper_payout_payment_events_item_idx
  on public.helper_payout_payment_events(payment_item_id) where payment_item_id is not null;

create table public.helper_payout_payment_hold_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  helper_id uuid not null,
  period_start date not null,
  period_end date not null,
  operation_id uuid not null,
  action text not null,
  state_changed boolean not null,
  remarks text not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint helper_payout_payment_hold_helper_company_fk
    foreign key (company_id, helper_id) references public.helpers(company_id, id) on delete restrict,
  constraint helper_payout_payment_hold_operation_unique unique (company_id, operation_id),
  constraint helper_payout_payment_hold_period_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint helper_payout_payment_hold_action_check check (action in ('hold', 'release')),
  constraint helper_payout_payment_hold_remarks_check
    check (length(btrim(remarks)) between 3 and 1000)
);

create index helper_payout_payment_hold_latest_idx
  on public.helper_payout_payment_hold_events(
    company_id, helper_id, period_start, period_end, created_at desc, id desc
  );

-- A single bank UTR/CIN represents one paid instruction regardless of whether
-- that instruction belongs to Workforce or Helpers. Per-ledger unique indexes
-- cannot enforce that cross-table invariant, so both ledgers claim the same
-- normalized transaction registry from their paid-transition triggers.
create table public.payout_bank_paid_transaction_registry (
  company_id uuid not null references public.companies(id) on delete restrict,
  normalized_utr text not null,
  payout_audience text not null,
  payment_item_id uuid not null,
  reference_no text not null,
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (company_id, normalized_utr),
  constraint payout_bank_paid_transaction_registry_item_unique
    unique (company_id, payout_audience, payment_item_id),
  constraint payout_bank_paid_transaction_registry_utr_check check (
    normalized_utr = regexp_replace(upper(btrim(normalized_utr)), '[^A-Z0-9]', '', 'g')
    and normalized_utr not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
  ),
  constraint payout_bank_paid_transaction_registry_audience_check
    check (payout_audience in ('workforce', 'helpers')),
  constraint payout_bank_paid_transaction_registry_reference_check
    check (nullif(btrim(reference_no), '') is not null)
);

-- Preserve already-finalized history. If a legacy cross-ledger duplicate is
-- present, keep one deterministic claim so the migration remains deployable;
-- every future paid transition is blocked by the shared primary key.
insert into public.payout_bank_paid_transaction_registry(
  company_id, normalized_utr, payout_audience, payment_item_id, reference_no, claimed_at
)
select distinct on (paid.company_id, paid.normalized_utr)
  paid.company_id, paid.normalized_utr, paid.payout_audience,
  paid.payment_item_id, paid.reference_no, paid.claimed_at
from (
  select item.company_id,
    regexp_replace(upper(btrim(coalesce(item.utr_cin, ''))), '[^A-Z0-9]', '', 'g') normalized_utr,
    'workforce'::text payout_audience, item.id payment_item_id,
    item.reference_no, coalesce(item.finalized_at, item.created_at, clock_timestamp()) claimed_at
  from public.workforce_payout_payment_items item
  where item.status = 'paid'
  union all
  select item.company_id,
    regexp_replace(upper(btrim(coalesce(item.utr_cin, ''))), '[^A-Z0-9]', '', 'g') normalized_utr,
    'helpers'::text payout_audience, item.id payment_item_id,
    item.reference_no, coalesce(item.finalized_at, item.created_at, clock_timestamp()) claimed_at
  from public.helper_payout_payment_items item
  where item.status = 'paid'
) paid
where paid.normalized_utr not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
order by paid.company_id, paid.normalized_utr, paid.claimed_at, paid.payout_audience, paid.payment_item_id;

alter table public.helper_payout_payment_batches enable row level security;
alter table public.helper_payout_payment_batches force row level security;
alter table public.helper_payout_payment_response_imports enable row level security;
alter table public.helper_payout_payment_response_imports force row level security;
alter table public.helper_payout_payment_items enable row level security;
alter table public.helper_payout_payment_items force row level security;
alter table public.helper_payout_payment_events enable row level security;
alter table public.helper_payout_payment_events force row level security;
alter table public.helper_payout_payment_hold_events enable row level security;
alter table public.helper_payout_payment_hold_events force row level security;
alter table public.payout_bank_paid_transaction_registry enable row level security;
alter table public.payout_bank_paid_transaction_registry force row level security;

revoke all on table public.helper_payout_payment_batches,
  public.helper_payout_payment_response_imports,
  public.helper_payout_payment_items,
  public.helper_payout_payment_events,
  public.helper_payout_payment_hold_events,
  public.payout_bank_paid_transaction_registry
  from public, anon, authenticated, service_role;
grant select on table public.helper_payout_payment_batches,
  public.helper_payout_payment_response_imports,
  public.helper_payout_payment_items,
  public.helper_payout_payment_events,
  public.helper_payout_payment_hold_events,
  public.payout_bank_paid_transaction_registry
  to service_role;

create policy helper_payout_payment_batches_service_select
  on public.helper_payout_payment_batches for select to service_role using (true);
create policy helper_payout_payment_response_service_select
  on public.helper_payout_payment_response_imports for select to service_role using (true);
create policy helper_payout_payment_items_service_select
  on public.helper_payout_payment_items for select to service_role using (true);
create policy helper_payout_payment_events_service_select
  on public.helper_payout_payment_events for select to service_role using (true);
create policy helper_payout_payment_hold_service_select
  on public.helper_payout_payment_hold_events for select to service_role using (true);
create policy payout_bank_paid_transaction_registry_service_select
  on public.payout_bank_paid_transaction_registry for select to service_role using (true);

create or replace function public.guard_helper_payout_payment_batch_ledger()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if current_setting('app.helper_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Helper payout payment batches may be changed only by bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then raise exception 'Helper payout payment batches cannot be deleted.'; end if;
  if tg_op = 'INSERT' then return new; end if;
  if (to_jsonb(new) - array['status','updated_at','completed_at']::text[])
    is distinct from (to_jsonb(old) - array['status','updated_at','completed_at']::text[])
  then raise exception 'A Helper payout payment batch is immutable after generation.'; end if;
  return new;
end
$function$;

create or replace function public.guard_helper_payout_payment_item_ledger()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if current_setting('app.helper_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Helper payout payment items may be changed only by bank-processing RPCs.';
  end if;
  if tg_op = 'DELETE' then raise exception 'Helper payout payment items cannot be deleted.'; end if;
  if tg_op = 'INSERT' then return new; end if;
  if (to_jsonb(new) - array[
      'status','bank_response_status','utr_cin','bank_processing_remarks',
      'response_import_id','finalized_by','finalized_at','updated_at'
    ]::text[]) is distinct from
    (to_jsonb(old) - array[
      'status','bank_response_status','utr_cin','bank_processing_remarks',
      'response_import_id','finalized_by','finalized_at','updated_at'
    ]::text[])
  then raise exception 'A Helper payout payment instruction is immutable after generation.'; end if;
  if old.status <> 'processing' or new.status not in ('paid','cancelled','failed') then
    raise exception 'A terminal Helper payout payment instruction is immutable.';
  end if;
  return new;
end
$function$;

create or replace function public.guard_helper_payout_payment_append_only()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if current_setting('app.helper_payout_payment_mutation', true) is distinct from 'allowed' then
    raise exception 'Helper payout payment audit rows may be appended only by bank-processing RPCs.';
  end if;
  if tg_op <> 'INSERT' then raise exception 'Helper payout payment audit rows are immutable.'; end if;
  return new;
end
$function$;

create or replace function public.guard_payout_bank_paid_transaction_registry()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Paid bank transaction claims are immutable.';
  end if;
  if current_setting('app.workforce_payout_payment_mutation', true) is distinct from 'allowed'
    and current_setting('app.helper_payout_payment_mutation', true) is distinct from 'allowed'
  then
    raise exception 'Paid bank transaction claims may be appended only by bank-processing RPCs.';
  end if;
  return new;
end
$function$;

create or replace function public.claim_payout_bank_paid_transaction()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_normalized_utr text;
  v_audience text := case when tg_table_name = 'helper_payout_payment_items' then 'helpers' else 'workforce' end;
  v_existing public.payout_bank_paid_transaction_registry%rowtype;
begin
  if new.status <> 'paid' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'paid' then
    return new;
  end if;
  v_normalized_utr := regexp_replace(upper(btrim(coalesce(new.utr_cin, ''))), '[^A-Z0-9]', '', 'g');
  if v_normalized_utr in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE') then
    raise exception 'A meaningful bank UTR/CIN is required for a paid instruction.';
  end if;
  insert into public.payout_bank_paid_transaction_registry(
    company_id, normalized_utr, payout_audience, payment_item_id, reference_no
  ) values (
    new.company_id, v_normalized_utr, v_audience, new.id, new.reference_no
  )
  on conflict (company_id, normalized_utr) do nothing;
  if not found then
    select claim.* into v_existing
    from public.payout_bank_paid_transaction_registry claim
    where claim.company_id = new.company_id and claim.normalized_utr = v_normalized_utr;
    if v_existing.payout_audience <> v_audience or v_existing.payment_item_id <> new.id then
      raise exception 'This UTR/CIN is already recorded for another paid instruction.';
    end if;
  end if;
  return new;
end
$function$;

create trigger helper_payout_payment_batches_00_ledger_guard
before insert or update or delete on public.helper_payout_payment_batches
for each row execute function public.guard_helper_payout_payment_batch_ledger();
create trigger helper_payout_payment_items_00_ledger_guard
before insert or update or delete on public.helper_payout_payment_items
for each row execute function public.guard_helper_payout_payment_item_ledger();
create trigger helper_payout_payment_response_00_append_only
before insert or update or delete on public.helper_payout_payment_response_imports
for each row execute function public.guard_helper_payout_payment_append_only();
create trigger helper_payout_payment_events_00_append_only
before insert or update or delete on public.helper_payout_payment_events
for each row execute function public.guard_helper_payout_payment_append_only();
create trigger helper_payout_payment_hold_00_append_only
before insert or update or delete on public.helper_payout_payment_hold_events
for each row execute function public.guard_helper_payout_payment_append_only();
create trigger payout_bank_paid_transaction_registry_00_append_only
  before insert or update or delete on public.payout_bank_paid_transaction_registry
  for each row execute function public.guard_payout_bank_paid_transaction_registry();
create trigger workforce_payout_payment_items_90_paid_transaction_claim
  after insert or update on public.workforce_payout_payment_items
  for each row execute function public.claim_payout_bank_paid_transaction();
create trigger helper_payout_payment_items_90_paid_transaction_claim
  after insert or update on public.helper_payout_payment_items
  for each row execute function public.claim_payout_bank_paid_transaction();

create or replace function public.helper_payout_payment_reference(
  p_helper_id uuid, p_dropx_id text, p_period_start date, p_version integer
)
returns text language plpgsql immutable set search_path = '' as $function$
declare
  v_dropx text := regexp_replace(upper(btrim(coalesce(p_dropx_id, ''))), '[^A-Z0-9]', '', 'g');
  v_helper_key text := replace(coalesce(p_helper_id::text, ''), '-', '');
  v_dropx_max_length integer;
  v_reference text;
begin
  if v_helper_key !~ '^[0-9a-f]{32}$' or v_dropx = ''
    or p_period_start is null or p_version is null or p_version < 1
  then
    raise exception 'A valid Helper profile, Helper ID, payout month and payment version are required.';
  end if;
  -- DropX IDs may legally differ only by punctuation (for example H-100 and
  -- H100), while FedOne references are alphanumeric. The complete UUID key
  -- keeps those profiles unambiguous; the readable DropX segment is truncated
  -- only as needed to keep the bank reference within 64 characters.
  v_dropx_max_length := 64 - 2 - length(v_helper_key) - 6 - 1 - length(p_version::text);
  if v_dropx_max_length < 1 then raise exception 'The Helper payment version is too long.'; end if;
  v_reference := 'HP' || left(v_dropx, v_dropx_max_length) || upper(v_helper_key)
    || to_char(p_period_start, 'MMYYYY') || 'V' || p_version::text;
  if length(v_reference) > 64 then raise exception 'The Helper payment reference is too long.'; end if;
  return v_reference;
end
$function$;

create or replace function public.helper_payout_payment_row_candidates(
  p_company_id uuid, p_period_start date, p_period_end date, p_rows jsonb
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
  helper_publication_id uuid,
  target_snapshot_hash text
)
language plpgsql security invoker set search_path = '' stable as $function$
declare
  v_selected record;
  v_helper public.helpers%rowtype;
  v_station public.stations%rowtype;
  v_publication public.helper_payout_publications%rowtype;
  v_review_status text;
  v_target numeric(14,2);
  v_paid numeric(14,2);
  v_processing numeric(14,2);
  v_latest_status text;
  v_source_change_id bigint := 0;
  v_dependency_hash text;
begin
  if p_company_id is null then raise exception 'Company is required for a Helper payment preview.'; end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then raise exception 'Helper bank payment preview requires one exact calendar month.'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'Select at least one Helper payout row.';
  end if;
  v_dependency_hash := public.helper_payout_shared_dependency_hash(
    p_company_id, p_period_start, p_period_end
  );
  if exists (
    select 1 from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or coalesce(selected.value ->> 'workforce_id','') !~* '^[0-9a-f-]{36}$'
      or coalesce(selected.value ->> 'station_id','') !~* '^[0-9a-f-]{36}$'
      or coalesce(selected.value ->> 'current_target_amount','') !~ '^[+-]?[0-9]+([.][0-9]{1,2})?$'
      or (selected.value ? 'current_snapshot_hash'
        and coalesce(selected.value ->> 'current_snapshot_hash','') !~ '^[0-9a-f]{64}$')
  ) then raise exception 'Every Helper payout row requires valid Helper, station and target amount values.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) selected(value)
    group by lower(selected.value ->> 'workforce_id'), lower(selected.value ->> 'station_id')
    having count(*) > 1
  ) then raise exception 'The same Helper payout row was selected more than once.'; end if;

  for v_selected in
    select (selected.value ->> 'workforce_id')::uuid helper_id,
      (selected.value ->> 'station_id')::uuid location_id,
      greatest(round((selected.value ->> 'current_target_amount')::numeric, 2), 0)::numeric(14,2) target,
      nullif(selected.value ->> 'current_snapshot_hash', '') live_snapshot_hash
    from jsonb_array_elements(p_rows) selected(value)
    order by 1, 2
  loop
    workforce_id := v_selected.helper_id;
    station_id := v_selected.location_id;
    dropx_id := null;
    station_code := null;
    current_target_amount := v_selected.target;
    paid_amount := 0;
    processing_amount := 0;
    balance_payable := v_selected.target;
    available_to_pay := v_selected.target;
    history_count := 0;
    payment_status := null;
    eligible := false;
    eligibility_code := null;
    eligibility_message := null;
    helper_publication_id := null;
    target_snapshot_hash := null;
    v_review_status := null;
    v_source_change_id := 0;

    select helper.* into v_helper from public.helpers helper
    where helper.company_id = p_company_id and helper.id = v_selected.helper_id;
    if not found then
      eligibility_code := 'profile_unavailable';
      eligibility_message := 'Helper profile is unavailable in this company.';
      return next; continue;
    end if;
    dropx_id := nullif(upper(btrim(coalesce(v_helper.dropx_id, ''))), '');

    select station.* into v_station from public.stations station
    where station.company_id = p_company_id and station.id = v_selected.location_id;
    if not found then
      eligibility_code := 'location_unavailable'; eligibility_message := 'Helper payout location is unavailable.';
      return next; continue;
    end if;
    station_code := nullif(upper(public.helper_payout_bank_text(v_station.station_code)), '');

    select publication.* into v_publication
    from public.helper_payout_publications publication
    where publication.company_id = p_company_id
      and publication.helper_id = v_selected.helper_id
      and publication.station_id = v_selected.location_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1;
    if found then
      helper_publication_id := v_publication.id;
      target_snapshot_hash := v_publication.snapshot_hash;
      select coalesce(max(change.id), 0)
      into v_source_change_id
      from public.helper_payout_dependency_changes change
      where change.company_id = p_company_id
        and change.helper_id = v_selected.helper_id
        and daterange(change.effective_from, coalesce(change.effective_to, 'infinity'::date), '[]')
          && daterange(p_period_start, p_period_end, '[]');
      select review.status into v_review_status
      from public.workforce_payout_review_submissions review
      where review.company_id = v_publication.company_id
        and review.id = v_publication.review_submission_id
        and review.subject_type = 'helper'
        and review.subject_id = v_publication.helper_id
        and review.location_id = v_publication.station_id
        and review.period_start = v_publication.period_start
        and review.period_end = v_publication.period_end;
      if coalesce(v_publication.snapshot #>> '{item,net_amount}', '') ~ '^[+-]?[0-9]+([.][0-9]+)?$' then
        current_target_amount := greatest(
          round((v_publication.snapshot #>> '{item,net_amount}')::numeric, 2), 0
        )::numeric(14,2);
      end if;
    end if;

    select coalesce(sum(item.instruction_amount) filter (where item.status = 'paid'), 0),
      coalesce(sum(item.instruction_amount) filter (where item.status = 'processing'), 0),
      count(*)::integer
    into v_paid, v_processing, history_count
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = v_selected.helper_id
      and item.location_id_snapshot = v_selected.location_id
      and item.period_start = p_period_start and item.period_end = p_period_end;
    paid_amount := round(v_paid, 2);
    processing_amount := round(v_processing, 2);
    balance_payable := greatest(current_target_amount - paid_amount, 0);
    available_to_pay := greatest(balance_payable - processing_amount, 0);
    select item.status into v_latest_status from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = v_selected.helper_id
      and item.location_id_snapshot = v_selected.location_id
      and item.period_start = p_period_start and item.period_end = p_period_end
    order by item.payment_version desc, item.id desc limit 1;
    payment_status := case
      when processing_amount > 0 then 'Payment Processing'
      when paid_amount > 0 and balance_payable = 0 then 'Paid'
      when v_latest_status = 'failed' then 'Payment Failed'
      when v_latest_status = 'cancelled' then 'Payment Cancelled'
      when paid_amount > 0 then 'Partially Paid'
      else null
    end;

    if v_helper.is_active is distinct from true or lower(btrim(coalesce(v_helper.onboarding_status, ''))) <> 'active' then
      available_to_pay := 0; eligibility_code := 'profile_not_active';
      eligibility_message := format('Helper ID %s is not Active.', coalesce(dropx_id, workforce_id::text));
      return next; continue;
    end if;
    if v_station.is_active is distinct from true then
      available_to_pay := 0; eligibility_code := 'location_inactive'; eligibility_message := 'Helper payout location is not active.';
      return next; continue;
    end if;
    if helper_publication_id is null or v_review_status not in ('under_review','approved')
      or v_publication.snapshot ->> 'schema_version' <> '2'
      or v_publication.snapshot ->> 'source' <> 'helper_payout_worksheet'
      or coalesce(v_publication.snapshot #>> '{item,net_amount}', '') !~ '^[+-]?[0-9]+([.][0-9]+)?$'
      or nullif(btrim(coalesce(v_publication.snapshot_hash, '')), '') is null
    then
      available_to_pay := 0; eligibility_code := 'publication_unavailable';
      eligibility_message := 'Send this Helper payout notification before creating its bank payment.';
      return next; continue;
    end if;
    if (v_selected.live_snapshot_hash is not null
        and v_selected.live_snapshot_hash <> v_publication.snapshot_hash)
      or abs(v_selected.target - current_target_amount) >= 0.01
      or v_publication.payout_source_change_id <> v_source_change_id
      or v_publication.payout_dependency_hash <> v_dependency_hash
    then
      available_to_pay := 0;
      eligibility_code := 'publication_outdated';
      eligibility_message := 'This Helper payout changed after its notification. Send the updated notification before creating a bank payment.';
      return next; continue;
    end if;
    if not exists (
      select 1 from public.helper_payment_allocations allocation
      where allocation.company_id = p_company_id and allocation.helper_id = v_selected.helper_id
        and allocation.station_id = v_selected.location_id and allocation.status <> 'cancelled'
        and allocation.effective_from <= p_period_end
        and (allocation.effective_to is null or allocation.effective_to >= p_period_start)
    ) then
      available_to_pay := 0; eligibility_code := 'payment_method_unavailable';
      eligibility_message := 'Helper payment allocation is unavailable for this payout row.';
      return next; continue;
    end if;
    if current_target_amount <= 0 or balance_payable <= 0 then
      available_to_pay := 0; eligibility_code := 'no_positive_balance'; eligibility_message := 'No positive Helper balance is payable.';
      return next; continue;
    end if;
    if processing_amount > 0 then
      available_to_pay := 0; payment_status := 'Payment Processing'; eligibility_code := 'payment_processing';
      eligibility_message := 'A Helper bank payment is already processing for this payout row.';
      return next; continue;
    end if;
    if coalesce((select hold.action = 'hold' from public.helper_payout_payment_hold_events hold
      where hold.company_id = p_company_id and hold.helper_id = v_selected.helper_id
        and hold.period_start = p_period_start and hold.period_end = p_period_end
      order by hold.created_at desc, hold.id desc limit 1), false)
    then
      available_to_pay := 0; payment_status := 'Payment On Hold'; eligibility_code := 'payment_on_hold';
      eligibility_message := 'Release the Helper payment hold before creating a bank payment.';
      return next; continue;
    end if;
    if not exists (
      select 1 from public.connect_profile_verifications verification
      where verification.company_id = p_company_id and verification.profile_type = 'worker'
        and verification.account_id = v_selected.helper_id and verification.kind = 'pan_aadhaar'
        and verification.verified = true
    ) then
      available_to_pay := 0; payment_status := 'PAN Not Linked'; eligibility_code := 'pan_not_linked';
      eligibility_message := 'PAN-Aadhaar must be linked before creating this Helper bank payment.';
      return next; continue;
    end if;
    if dropx_id is null or regexp_replace(dropx_id, '[^A-Z0-9]', '', 'g') = '' then
      available_to_pay := 0; eligibility_code := 'dropx_id_missing'; eligibility_message := 'Helper DropX ID is required.';
      return next; continue;
    end if;
    if public.helper_payout_bank_text(v_helper.full_name) = '' then
      available_to_pay := 0; eligibility_code := 'beneficiary_name_missing';
      eligibility_message := format('Beneficiary name for Helper ID %s is required.', dropx_id);
      return next; continue;
    end if;
    if station_code is null then
      available_to_pay := 0; eligibility_code := 'location_code_missing'; eligibility_message := 'Helper location code is required.';
      return next; continue;
    end if;
    if nullif(btrim(coalesce(v_helper.bank_account_no, '')), '') is null
      or nullif(btrim(coalesce(v_helper.ifsc_code, '')), '') is null
    then
      available_to_pay := 0; eligibility_code := 'bank_details_missing';
      eligibility_message := format('Bank details for Helper ID %s are incomplete.', dropx_id);
      return next; continue;
    end if;
    if public.workforce_payout_bank_account_canonical(v_helper.bank_account_no) !~ '^[A-Z0-9]{4,30}$' then
      available_to_pay := 0; eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format('Bank account for Helper ID %s is invalid.', dropx_id);
      return next; continue;
    end if;
    if public.workforce_payout_bank_ifsc_canonical(v_helper.ifsc_code) !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
      available_to_pay := 0; eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format('IFSC for Helper ID %s is invalid.', dropx_id);
      return next; continue;
    end if;
    -- The complete Helper UUID is included in every bank reference, so
    -- punctuation-insensitive DropX IDs cannot collide. Long readable IDs are
    -- deterministically truncated by helper_payout_payment_reference().
    eligible := true; eligibility_code := 'eligible'; eligibility_message := '';
    return next;
  end loop;
end
$function$;

create or replace function public.helper_preview_payout_payment_rows(
  p_company_id uuid, p_period_start date, p_period_end date, p_rows jsonb
)
returns table (
  workforce_id uuid, station_id uuid, dropx_id text,
  current_target_amount numeric(14,2), paid_amount numeric(14,2),
  processing_amount numeric(14,2), balance_payable numeric(14,2),
  available_to_pay numeric(14,2), history_count integer, payment_status text,
  eligible boolean, eligibility_code text, eligibility_message text
)
language sql security definer set search_path = '' stable as $function$
  select candidate.workforce_id, candidate.station_id, candidate.dropx_id,
    candidate.current_target_amount, candidate.paid_amount, candidate.processing_amount,
    candidate.balance_payable, candidate.available_to_pay, candidate.history_count,
    candidate.payment_status, candidate.eligible, candidate.eligibility_code,
    candidate.eligibility_message
  from public.helper_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, p_rows
  ) candidate
  order by candidate.workforce_id, candidate.station_id;
$function$;

create or replace function public.helper_payout_payment_batch_result(p_batch_id uuid, p_replayed boolean)
returns jsonb language sql security definer set search_path = '' stable as $function$
  select jsonb_build_object(
    'batch_id', batch.id, 'replayed', p_replayed, 'status', batch.status,
    'period_start', batch.period_start, 'period_end', batch.period_end,
    'value_date', batch.value_date,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', item.id, 'workforce_id', item.helper_id,
      'dropx_id', item.dropx_id_snapshot, 'payment_version', item.payment_version,
      'reference_no', item.reference_no, 'status', item.status,
      'instruction_amount', item.instruction_amount,
      'current_target_amount', item.current_target_amount,
      'paid_before_amount', item.paid_before_amount,
      'bank_account_no', item.bank_account_no_snapshot, 'ifsc', item.ifsc_snapshot,
      'beneficiary_name', item.beneficiary_name_snapshot,
      'beneficiary_email', coalesce(item.beneficiary_email_snapshot, ''),
      'credit_remarks', item.credit_remarks_snapshot, 'debit_remarks', item.debit_remarks_snapshot,
      'debit_account_no', batch.debit_account_no_snapshot, 'value_date', batch.value_date,
      'bank_id', batch.bank_id, 'file_type', batch.file_type_snapshot
    ) order by item.dropx_id_snapshot, item.reference_no)
    from public.helper_payout_payment_items item where item.batch_id = batch.id), '[]'::jsonb)
  ) from public.helper_payout_payment_batches batch where batch.id = p_batch_id;
$function$;

-- Cheap replay probe used by the API before it reloads live Helper payout
-- dependencies. The advisory lock is identical to create, so a concurrent
-- first execution either commits and replays here or rolls back and leaves
-- the caller to perform the authoritative first-execution calculation.
create or replace function public.helper_replay_payout_payment_row_batch(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_request_fingerprint text,
  p_bank_id uuid,
  p_period_start date,
  p_period_end date,
  p_value_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.helper_payout_payment_batches%rowtype;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_bank_id is null or p_period_start is null or p_period_end is null
    or p_value_date is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception 'A complete Helper payment replay identity is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-payment-create:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select batch.* into v_existing
  from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.operation_id = p_operation_id;
  if not found then return null; end if;

  if v_existing.request_fingerprint <> p_request_fingerprint
    or v_existing.bank_id <> p_bank_id
    or v_existing.period_start <> p_period_start
    or v_existing.period_end <> p_period_end
    or v_existing.value_date <> p_value_date
    or v_existing.generated_by <> p_actor_user_id
  then
    raise exception 'This Helper payment operation ID was already used for a different request.';
  end if;
  if v_existing.status <> 'processing' or exists (
    select 1
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.batch_id = v_existing.id
      and item.status <> 'processing'
  ) then
    raise exception 'This Helper payment batch is already partially or fully finalized.';
  end if;
  return public.helper_payout_payment_batch_result(v_existing.id, true);
end
$function$;

create or replace function public.helper_create_payout_payment_row_batch(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_request_fingerprint text, p_bank_id uuid, p_period_start date,
  p_period_end date, p_value_date date, p_rows jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_rows jsonb;
  v_ids uuid[];
  v_existing public.helper_payout_payment_batches%rowtype;
  v_bank public.payment_banks%rowtype;
  v_helper public.helpers%rowtype;
  v_candidate record;
  v_batch_id uuid := gen_random_uuid();
  v_item_id uuid;
  v_version integer;
  v_reference text;
  v_created integer := 0;
  v_eligible integer := 0;
  v_locked integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null or p_bank_id is null then
    raise exception 'Company, actor, operation and bank are required for a Helper payment batch.';
  end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then raise exception 'Helper bank payment generation requires one exact calendar month.'; end if;
  if p_value_date is null
    or p_value_date < date '1900-01-01'
    or p_value_date > date '9999-12-31'
  then raise exception 'Bank value date must be between 1900-01-01 and 9999-12-31.'; end if;
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 request fingerprint is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then
    raise exception 'Select at least one Helper payout row.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) selected(value)
    where lower(btrim(coalesce(selected.value ->> 'expected_dependency_hash', '')))
        !~ '^[0-9a-f]{32}$'
      or coalesce(selected.value ->> 'expected_source_change_id', '') !~ '^[0-9]+$'
  ) then
    raise exception 'Reload the selected Helper payouts before creating a bank payment.';
  end if;

  select jsonb_agg(jsonb_build_object(
      'workforce_id', normalized.helper_id,
      'station_id', normalized.station_id,
      'current_target_amount', normalized.target,
      'current_snapshot_hash', normalized.live_snapshot_hash
    ) order by normalized.helper_id, normalized.station_id),
    array_agg(distinct normalized.helper_id order by normalized.helper_id)
  into v_rows, v_ids
  from (
    select (selected.value ->> 'workforce_id')::uuid helper_id,
      (selected.value ->> 'station_id')::uuid station_id,
      greatest(round((selected.value ->> 'current_target_amount')::numeric, 2), 0)::numeric(14,2) target,
      nullif(selected.value ->> 'current_snapshot_hash', '') live_snapshot_hash
    from jsonb_array_elements(p_rows) selected(value)
  ) normalized;

  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-payment-create:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select batch.* into v_existing from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_helper_ids <> v_ids or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date or v_existing.generated_by <> p_actor_user_id
    then raise exception 'This Helper payment operation ID was already used for a different request.'; end if;
    if v_existing.status <> 'processing' or exists (
      select 1 from public.helper_payout_payment_items item
      where item.company_id = p_company_id and item.batch_id = v_existing.id and item.status <> 'processing'
    ) then raise exception 'This Helper payment batch is already partially or fully finalized.'; end if;
    return public.helper_payout_payment_batch_result(v_existing.id, true);
  end if;

  perform 1 from public.helpers helper
  where helper.company_id = p_company_id and helper.id = any(v_ids)
  order by helper.id for update;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(v_ids) then raise exception 'One or more selected Helper profiles are unavailable.'; end if;

  -- Shared dependency writers take this company mutex before bumping their
  -- revision. With Helper rows already locked, every current publication
  -- watermark checked below remains stable until the batch commits.
  perform public.lock_workforce_payment_allocation_company(p_company_id);
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    left join lateral (
      select coalesce(max(change.id), 0) as source_change_id
      from public.helper_payout_dependency_changes change
      where change.company_id = p_company_id
        and change.helper_id = (selected.value ->> 'workforce_id')::uuid
        and daterange(change.effective_from, coalesce(change.effective_to, 'infinity'::date), '[]')
          && daterange(p_period_start, p_period_end, '[]')
    ) source_state on true
    where lower(btrim(selected.value ->> 'expected_dependency_hash'))
        is distinct from public.helper_payout_shared_dependency_hash(
          p_company_id, p_period_start, p_period_end
        )
      or (selected.value ->> 'expected_source_change_id')::bigint
        is distinct from source_state.source_change_id
  ) then
    raise exception 'Helper payout inputs changed while payouts were loading. Refresh and review the recalculated amounts.';
  end if;

  select batch.* into v_existing from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.operation_id = p_operation_id;
  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.selected_helper_ids <> v_ids or v_existing.bank_id <> p_bank_id
      or v_existing.period_start <> p_period_start or v_existing.period_end <> p_period_end
      or v_existing.value_date <> p_value_date or v_existing.generated_by <> p_actor_user_id
    then
      raise exception 'This Helper payment operation ID was already used for a different request.';
    end if;
    if v_existing.status <> 'processing' or exists (
      select 1 from public.helper_payout_payment_items item
      where item.company_id = p_company_id and item.batch_id = v_existing.id and item.status <> 'processing'
    ) then raise exception 'This Helper payment batch is already partially or fully finalized.'; end if;
    return public.helper_payout_payment_batch_result(v_existing.id, true);
  end if;

  select bank.* into v_bank from public.payment_banks bank
  where bank.company_id = p_company_id and bank.id = p_bank_id and bank.is_active = true
    and upper(btrim(bank.bank_code)) = 'FEDERAL_BANK' for share;
  if not found then raise exception 'Select the active Federal Bank FedOne payment bank configured for this company.'; end if;
  if public.workforce_payout_bank_account_canonical(v_bank.account_no) !~ '^[A-Z0-9]{4,30}$' then
    raise exception 'The selected Federal Bank debit account is invalid.';
  end if;
  if public.workforce_payout_bank_ifsc_canonical(v_bank.ifsc) !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'The selected Federal Bank IFSC is invalid.';
  end if;

  for v_candidate in select * from public.helper_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, v_rows
  ) loop
    if v_candidate.eligible then v_eligible := v_eligible + 1;
    elsif v_candidate.eligibility_code <> 'no_positive_balance' then
      raise exception '%', v_candidate.eligibility_message;
    end if;
  end loop;
  if v_eligible < 1 then raise exception 'The selected Helper payout rows have no positive balance payable.'; end if;

  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  insert into public.helper_payout_payment_batches(
    id, company_id, operation_id, request_fingerprint, selected_helper_ids,
    bank_id, period_start, period_end, value_date, debit_account_no_snapshot,
    bank_code_snapshot, file_type_snapshot, status, generated_by
  ) values (
    v_batch_id, p_company_id, p_operation_id, p_request_fingerprint, v_ids,
    p_bank_id, p_period_start, p_period_end, p_value_date,
    public.workforce_payout_bank_account_canonical(v_bank.account_no),
    upper(btrim(v_bank.bank_code)), 'fedone', 'processing', p_actor_user_id
  );

  for v_candidate in select * from public.helper_payout_payment_row_candidates(
    p_company_id, p_period_start, p_period_end, v_rows
  ) order by workforce_id, station_id loop
    if not v_candidate.eligible then continue; end if;
    select helper.* into v_helper from public.helpers helper
    where helper.company_id = p_company_id and helper.id = v_candidate.workforce_id;
    select coalesce(max(item.payment_version), 0) + 1 into v_version
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = v_candidate.workforce_id
      and item.period_start = p_period_start and item.period_end = p_period_end;
    v_reference := public.helper_payout_payment_reference(
      v_candidate.workforce_id, v_helper.dropx_id, p_period_start, v_version
    );
    insert into public.helper_payout_payment_items(
      company_id, batch_id, helper_id, period_start, period_end, payment_version,
      reference_no, dropx_id_snapshot, beneficiary_name_snapshot,
      beneficiary_email_snapshot, bank_account_no_snapshot, ifsc_snapshot,
      location_id_snapshot, location_code_snapshot, debit_remarks_snapshot,
      credit_remarks_snapshot, helper_publication_id, target_snapshot_hash,
      current_target_amount, paid_before_amount, instruction_amount, status
    ) values (
      p_company_id, v_batch_id, v_candidate.workforce_id, p_period_start, p_period_end,
      v_version, v_reference, upper(btrim(v_helper.dropx_id)),
      public.helper_payout_bank_text(v_helper.full_name),
      nullif(public.helper_payout_bank_text(v_helper.email), ''),
      public.workforce_payout_bank_account_canonical(v_helper.bank_account_no),
      public.workforce_payout_bank_ifsc_canonical(v_helper.ifsc_code),
      v_candidate.station_id, v_candidate.station_code, 'NET PAY', v_candidate.station_code,
      v_candidate.helper_publication_id, v_candidate.target_snapshot_hash,
      v_candidate.current_target_amount, v_candidate.paid_amount, v_candidate.available_to_pay,
      'processing'
    ) returning id into v_item_id;
    insert into public.helper_payout_payment_events(
      company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
    ) values (
      p_company_id, v_batch_id, v_item_id, 'payment_instruction_created',
      jsonb_build_object('reference_no', v_reference, 'payment_version', v_version,
        'current_target_amount', v_candidate.current_target_amount,
        'paid_before_amount', v_candidate.paid_amount,
        'instruction_amount', v_candidate.available_to_pay,
        'station_id', v_candidate.station_id, 'selection_mode', 'payout_row'),
      p_actor_user_id
    );
    v_created := v_created + 1;
  end loop;
  if v_created < 1 then raise exception 'The selected Helper payout rows have no positive balance payable.'; end if;
  insert into public.helper_payout_payment_events(
    company_id, batch_id, event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_batch_id, 'bank_file_generated',
    jsonb_build_object('payment_count', v_created, 'selected_row_count', jsonb_array_length(v_rows),
      'value_date', p_value_date, 'bank_id', p_bank_id, 'selection_mode', 'payout_row'),
    p_actor_user_id
  );
  return public.helper_payout_payment_batch_result(v_batch_id, false);
end
$function$;

create or replace function public.helper_finalize_payout_payment_response(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_file_sha256 text, p_file_name text, p_rows jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_existing public.helper_payout_payment_response_imports%rowtype;
  v_import_id uuid := gen_random_uuid();
  v_record record;
  v_row jsonb;
  v_row_number integer;
  v_reference text;
  v_account text;
  v_ifsc text;
  v_amount_paise_text text;
  v_status text;
  v_utr text;
  v_utr_normalized text;
  v_remarks text;
  v_item public.helper_payout_payment_items%rowtype;
  v_batch_id uuid;
  v_batch_ids uuid[] := '{}'::uuid[];
  v_processing_count integer;
  v_terminal_count integer;
  v_batch_status text;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_operation_lock_key bigint;
  v_file_lock_key bigint;
  v_paid_count integer := 0;
  v_cancelled_count integer := 0;
  v_replayed_count integer := 0;
  v_rejected_count integer := 0;
  v_unknown_count integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required for a Helper bank response.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 bank response file hash is required.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid bank response file name is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 5000
  then raise exception 'Bank response must contain between 1 and 5000 normalized rows.'; end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  -- Serialize both idempotency identities before their authoritative replay
  -- lookups. Sorting the advisory keys keeps acquisition deterministic even
  -- when two requests reuse one identity with a different counterpart.
  v_operation_lock_key := pg_catalog.hashtextextended(
    'helper-payout-payment-response-operation:' || p_company_id::text || ':' || p_operation_id::text, 0
  );
  v_file_lock_key := pg_catalog.hashtextextended(
    'helper-payout-payment-response-file:' || p_company_id::text || ':' || p_file_sha256, 0
  );
  perform pg_catalog.pg_advisory_xact_lock(least(v_operation_lock_key, v_file_lock_key));
  if v_operation_lock_key <> v_file_lock_key then
    perform pg_catalog.pg_advisory_xact_lock(greatest(v_operation_lock_key, v_file_lock_key));
  end if;

  select imported.* into v_existing from public.helper_payout_payment_response_imports imported
  where imported.company_id = p_company_id and imported.operation_id = p_operation_id;
  if found then
    if v_existing.file_sha256 <> p_file_sha256 or v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This Helper bank response operation ID was already used for a different payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;
  select imported.* into v_existing from public.helper_payout_payment_response_imports imported
  where imported.company_id = p_company_id and imported.file_sha256 = p_file_sha256;
  if found then
    if v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This Helper bank response file hash was recorded with a different payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;
  if exists (
    select 1 from (
      select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no') reference_no
      from jsonb_array_elements(p_rows) row(value)
    ) normalized where normalized.reference_no <> ''
    group by normalized.reference_no having count(*) > 1
  ) then raise exception 'The bank response contains the same customer reference more than once.'; end if;

  perform 1 from public.helpers helper
  where helper.company_id = p_company_id and helper.id in (
    select distinct item.helper_id from public.helper_payout_payment_items item
    join (select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no') reference_no
      from jsonb_array_elements(p_rows) row(value)) response
      on response.reference_no = item.reference_no
    where item.company_id = p_company_id
  ) order by helper.id for update;
  perform 1 from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.id in (
    select distinct item.batch_id from public.helper_payout_payment_items item
    join (select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no') reference_no
      from jsonb_array_elements(p_rows) row(value)) response
      on response.reference_no = item.reference_no
    where item.company_id = p_company_id
  ) order by batch.id for update;
  perform 1 from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.reference_no in (
    select public.workforce_payout_bank_reference_canonical(row.value ->> 'reference_no')
    from jsonb_array_elements(p_rows) row(value)
  ) order by item.helper_id, item.period_start, item.payment_version, item.id for update;

  -- Close operation/file hash races after the subject and instruction locks.
  select imported.* into v_existing from public.helper_payout_payment_response_imports imported
  where imported.company_id = p_company_id and imported.operation_id = p_operation_id;
  if found then
    if v_existing.file_sha256 <> p_file_sha256 or v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This Helper bank response operation ID was already used for a different payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;
  select imported.* into v_existing from public.helper_payout_payment_response_imports imported
  where imported.company_id = p_company_id and imported.file_sha256 = p_file_sha256;
  if found then
    if v_existing.normalized_rows is distinct from p_rows then
      raise exception 'This Helper bank response file hash was recorded with a different payload.';
    end if;
    return v_existing.result_snapshot || jsonb_build_object('replayed', true, 'response_import_id', v_existing.id);
  end if;

  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  for v_record in
    select response.value, response.ordinality::integer row_number
    from jsonb_array_elements(p_rows) with ordinality response(value, ordinality)
    order by response.ordinality
  loop
    v_row := v_record.value;
    v_row_number := case when coalesce(v_row ->> 'row_number','') ~ '^[1-9][0-9]*$'
      then (v_row ->> 'row_number')::integer else v_record.row_number end;
    v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
    v_account := public.workforce_payout_bank_account_canonical(v_row ->> 'credit_account');
    v_ifsc := public.workforce_payout_bank_ifsc_canonical(v_row ->> 'ifsc');
    v_amount_paise_text := btrim(coalesce(v_row ->> 'debit_amount_paise',''));
    v_status := upper(btrim(coalesce(v_row ->> 'status','')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr := btrim(coalesce(v_row ->> 'utr_cin',''));
    v_utr_normalized := regexp_replace(upper(v_utr), '[^A-Z0-9]', '', 'g');
    v_remarks := btrim(coalesce(v_row ->> 'remarks',''));

    if v_reference = '' or length(v_reference) > 64
      or v_reference !~ '^HP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Customer reference is not a valid Helper payment reference.'));
      continue;
    end if;
    select item.* into v_item from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.reference_no = v_reference;
    if not found then
      v_unknown_count := v_unknown_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'unknown', 'message', 'No Helper payment instruction matches this reference.'));
      continue;
    end if;
    v_batch_ids := array_append(v_batch_ids, v_item.batch_id);
    if v_amount_paise_text !~ '^[1-9][0-9]*$'
      or v_account !~ '^[A-Z0-9]{4,30}$' or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise_text::numeric <> round(v_item.instruction_amount * 100, 0)
    then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Account, IFSC or exact debit amount does not match the instruction.'));
      continue;
    end if;
    if v_status not in ('PAID','CANCELLED') then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'Status must be PAID or CANCELLED.'));
      continue;
    end if;
    if v_status = 'PAID' and v_utr_normalized in (
      '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
    ) then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'A meaningful bank UTR/CIN is required for a paid instruction.'));
      continue;
    end if;
    if v_status = 'PAID' and (
      exists (select 1 from public.helper_payout_payment_items paid
        where paid.company_id = p_company_id and paid.status = 'paid' and paid.id <> v_item.id
          and regexp_replace(upper(btrim(coalesce(paid.utr_cin,''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized)
      or exists (select 1 from public.workforce_payout_payment_items paid
        where paid.company_id = p_company_id and paid.status = 'paid'
          and regexp_replace(upper(btrim(coalesce(paid.utr_cin,''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized)
    ) then
      v_rejected_count := v_rejected_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number, 'reference_no', v_reference,
        'outcome', 'rejected', 'message', 'This UTR/CIN is already recorded for another paid instruction.'));
      continue;
    end if;
    if v_item.status <> 'processing' then
      if v_item.bank_response_status = v_status
        and regexp_replace(upper(btrim(coalesce(v_item.utr_cin,''))), '[^A-Z0-9]', '', 'g') = v_utr_normalized
        and btrim(coalesce(v_item.bank_processing_remarks,'')) = v_remarks
      then
        v_replayed_count := v_replayed_count + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'replayed', 'message', 'This exact terminal response was already recorded.'));
      else
        v_rejected_count := v_rejected_count + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number, 'reference_no', v_reference,
          'outcome', 'rejected', 'message', 'This payment is already terminal with a different response.'));
      end if;
      continue;
    end if;
    update public.helper_payout_payment_items item set
      status = case when v_status = 'PAID' then 'paid' else 'cancelled' end,
      bank_response_status = v_status, utr_cin = nullif(v_utr,''),
      bank_processing_remarks = nullif(v_remarks,''), response_import_id = v_import_id,
      finalized_by = p_actor_user_id, finalized_at = clock_timestamp(), updated_at = clock_timestamp()
    where item.id = v_item.id;
    if v_status = 'PAID' then v_paid_count := v_paid_count + 1;
    else v_cancelled_count := v_cancelled_count + 1; end if;
    insert into public.helper_payout_payment_events(
      company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
    ) values (
      p_company_id, v_item.batch_id, v_item.id,
      case when v_status = 'PAID' then 'payment_paid' else 'payment_cancelled' end,
      jsonb_build_object('response_import_id', v_import_id, 'reference_no', v_reference,
        'utr_cin', nullif(v_utr,''), 'processing_remarks', nullif(v_remarks,'')), p_actor_user_id
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row_number', v_row_number, 'reference_no', v_reference, 'outcome', lower(v_status),
      'message', case when v_status = 'PAID' then 'Payment finalized as paid.'
        else 'Payment cancelled and unlocked for a new version.' end));
  end loop;

  select coalesce(array_agg(distinct batch_id order by batch_id), '{}'::uuid[])
  into v_batch_ids from unnest(v_batch_ids) batch_id;
  foreach v_batch_id in array v_batch_ids loop
    select count(*) filter (where item.status = 'processing')::integer,
      count(*) filter (where item.status in ('paid','cancelled','failed'))::integer
    into v_processing_count, v_terminal_count from public.helper_payout_payment_items item
    where item.batch_id = v_batch_id;
    v_batch_status := case when v_processing_count = 0 then 'completed'
      when v_terminal_count > 0 then 'partially_finalized' else 'processing' end;
    update public.helper_payout_payment_batches batch set status = v_batch_status,
      updated_at = clock_timestamp(), completed_at = case when v_batch_status = 'completed'
        then coalesce(batch.completed_at, clock_timestamp()) else null end
    where batch.id = v_batch_id;
  end loop;
  v_result := jsonb_build_object(
    'response_import_id', v_import_id, 'replayed', false, 'paid', v_paid_count,
    'cancelled', v_cancelled_count, 'replayed_items', v_replayed_count,
    'rejected', v_rejected_count, 'unknown', v_unknown_count,
    'batch_ids', to_jsonb(v_batch_ids), 'rows', v_results
  );
  insert into public.helper_payout_payment_response_imports(
    id, company_id, operation_id, file_sha256, file_name,
    normalized_rows, batch_ids, result_snapshot, imported_by
  ) values (v_import_id, p_company_id, p_operation_id, p_file_sha256, btrim(p_file_name),
    p_rows, v_batch_ids, v_result, p_actor_user_id);
  insert into public.helper_payout_payment_events(
    company_id, response_import_id, event_type, event_data, actor_user_id
  ) values (p_company_id, v_import_id, 'bank_response_imported',
    jsonb_build_object('paid', v_paid_count, 'cancelled', v_cancelled_count,
      'replayed_items', v_replayed_count, 'rejected', v_rejected_count,
      'unknown', v_unknown_count, 'batch_ids', to_jsonb(v_batch_ids)), p_actor_user_id);
  return v_result;
end
$function$;

create or replace function public.helper_transition_payout_payment_item(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_payment_item_id uuid, p_outcome text, p_remarks text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_item public.helper_payout_payment_items%rowtype;
  v_existing public.helper_payout_payment_events%rowtype;
  v_outcome text := lower(btrim(coalesce(p_outcome,'')));
  v_remarks text := btrim(coalesce(p_remarks,''));
  v_processing integer;
  v_terminal integer;
  v_batch_status text;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null or p_payment_item_id is null then
    raise exception 'Company, actor, operation and payment item are required.';
  end if;
  if v_outcome not in ('failed','cancelled') then raise exception 'Manual payment status must be failed or cancelled.'; end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment status remark between 3 and 1000 characters.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-payment-event-operation:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select event.* into v_existing from public.helper_payout_payment_events event
  where event.company_id = p_company_id and event.operation_id = p_operation_id;
  if found then
    if v_existing.event_data ->> 'payment_item_id' is distinct from p_payment_item_id::text
      or v_existing.event_data ->> 'outcome' is distinct from v_outcome
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then raise exception 'This Helper payment status operation ID was already used for a different request.'; end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;
  select item.* into v_item from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id;
  if not found then raise exception 'Helper payment instruction was not found.'; end if;
  perform 1 from public.helpers helper
  where helper.company_id = p_company_id and helper.id = v_item.helper_id for update;
  perform 1 from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.id = v_item.batch_id
  order by batch.id for update;
  select item.* into v_item from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = p_payment_item_id for update;
  if v_item.status <> 'processing' then raise exception 'Only a Payment Processing instruction can be changed manually.'; end if;
  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  update public.helper_payout_payment_items item set
    status = v_outcome,
    bank_response_status = case when v_outcome = 'failed' then 'MANUAL_FAILED' else 'MANUAL_CANCELLED' end,
    utr_cin = null, bank_processing_remarks = v_remarks, response_import_id = null,
    finalized_by = p_actor_user_id, finalized_at = clock_timestamp(), updated_at = clock_timestamp()
  where item.id = v_item.id;
  select count(*) filter (where item.status = 'processing')::integer,
    count(*) filter (where item.status in ('paid','cancelled','failed'))::integer
  into v_processing, v_terminal from public.helper_payout_payment_items item
  where item.batch_id = v_item.batch_id;
  v_batch_status := case when v_processing = 0 then 'completed'
    when v_terminal > 0 then 'partially_finalized' else 'processing' end;
  update public.helper_payout_payment_batches batch set status = v_batch_status,
    updated_at = clock_timestamp(), completed_at = case when v_batch_status = 'completed'
      then coalesce(batch.completed_at, clock_timestamp()) else null end
  where batch.id = v_item.batch_id;
  v_result := jsonb_build_object(
    'payment_item_id', v_item.id, 'batch_id', v_item.batch_id,
    'reference_no', v_item.reference_no, 'outcome', v_outcome,
    'remarks', v_remarks, 'batch_status', v_batch_status, 'replayed', false
  );
  insert into public.helper_payout_payment_events(
    company_id, batch_id, payment_item_id, operation_id, event_type, event_data, actor_user_id
  ) values (
    p_company_id, v_item.batch_id, v_item.id, p_operation_id,
    case when v_outcome = 'failed' then 'payment_failed_manually' else 'payment_cancelled_manually' end,
    v_result, p_actor_user_id
  );
  return v_result;
end
$function$;

create or replace function public.helper_set_payout_payment_hold(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_workforce_id uuid, p_period_start date, p_period_end date,
  p_hold boolean, p_remarks text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_existing public.helper_payout_payment_hold_events%rowtype;
  v_current public.helper_payout_payment_hold_events%rowtype;
  v_action text := case when p_hold then 'hold' else 'release' end;
  v_remarks text := btrim(coalesce(p_remarks,''));
  v_is_held boolean := false;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null
    or p_workforce_id is null or p_hold is null
  then raise exception 'Company, actor, operation, Helper profile and hold state are required.'; end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then raise exception 'Payment holds require one exact calendar month.'; end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment hold remark between 3 and 1000 characters.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-payment-hold:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select hold.* into v_existing from public.helper_payout_payment_hold_events hold
  where hold.company_id = p_company_id and hold.operation_id = p_operation_id;
  if found then
    if v_existing.helper_id <> p_workforce_id or v_existing.period_start <> p_period_start
      or v_existing.period_end <> p_period_end or v_existing.action <> v_action
      or v_existing.remarks <> v_remarks or v_existing.actor_user_id <> p_actor_user_id
    then raise exception 'This Helper payment hold operation ID was used for a different request.'; end if;
    return jsonb_build_object('changed', v_existing.state_changed, 'replayed', true,
      'hold_event_id', v_existing.id, 'on_hold', v_existing.action = 'hold', 'remarks', v_existing.remarks);
  end if;
  perform 1 from public.helpers helper
  where helper.company_id = p_company_id and helper.id = p_workforce_id for update;
  if not found then raise exception 'Helper profile was not found in this company.'; end if;
  select hold.* into v_current from public.helper_payout_payment_hold_events hold
  where hold.company_id = p_company_id and hold.helper_id = p_workforce_id
    and hold.period_start = p_period_start and hold.period_end = p_period_end
  order by hold.created_at desc, hold.id desc limit 1;
  v_is_held := found and v_current.action = 'hold';
  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  insert into public.helper_payout_payment_hold_events(
    company_id, helper_id, period_start, period_end, operation_id,
    action, state_changed, remarks, actor_user_id
  ) values (
    p_company_id, p_workforce_id, p_period_start, p_period_end, p_operation_id,
    v_action, v_is_held is distinct from p_hold, v_remarks, p_actor_user_id
  ) returning * into v_current;
  return jsonb_build_object('changed', v_current.state_changed, 'replayed', false,
    'hold_event_id', v_current.id, 'on_hold', p_hold, 'remarks', v_remarks);
end
$function$;

create or replace function public.helper_cancel_payout_payment_items(
  p_company_id uuid, p_actor_user_id uuid, p_operation_id uuid,
  p_payment_item_ids uuid[], p_period_start date, p_period_end date, p_remarks text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_ids uuid[];
  v_count integer;
  v_matching integer;
  v_remarks text := btrim(coalesce(p_remarks,''));
  v_existing public.helper_payout_payment_events%rowtype;
  v_first public.helper_payout_payment_items%rowtype;
  v_batches uuid[];
  v_now timestamptz;
  v_items jsonb;
  v_result jsonb;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required.';
  end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then raise exception 'Choose one complete payout month.'; end if;
  if length(v_remarks) < 3 or length(v_remarks) > 1000 then
    raise exception 'Enter a payment cancellation remark between 3 and 1000 characters.';
  end if;
  if p_payment_item_ids is null or cardinality(p_payment_item_ids) < 1
    or array_position(p_payment_item_ids, null) is not null
  then raise exception 'Select at least one processing payment.'; end if;
  select array_agg(distinct requested.id order by requested.id) into v_ids
  from unnest(p_payment_item_ids) requested(id);
  v_count := cardinality(v_ids);
  if v_count <> cardinality(p_payment_item_ids) then raise exception 'Each payment may be selected only once.'; end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'helper-payout-payment-event-operation:' || p_company_id::text || ':' || p_operation_id::text, 0
  ));
  select event.* into v_existing from public.helper_payout_payment_events event
  where event.company_id = p_company_id and event.operation_id = p_operation_id;
  if found then
    if v_existing.event_type <> 'payment_cancelled_bulk'
      or v_existing.event_data -> 'payment_item_ids' is distinct from to_jsonb(v_ids)
      or v_existing.event_data ->> 'period_start' is distinct from p_period_start::text
      or v_existing.event_data ->> 'period_end' is distinct from p_period_end::text
      or v_existing.event_data ->> 'remarks' is distinct from v_remarks
      or v_existing.actor_user_id <> p_actor_user_id
    then raise exception 'This Helper bulk cancellation operation ID was used for a different request.'; end if;
    return v_existing.event_data || jsonb_build_object('replayed', true);
  end if;
  select count(*)::integer into v_matching from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = any(v_ids)
    and item.period_start = p_period_start and item.period_end = p_period_end;
  if v_matching <> v_count then raise exception 'Every selected payment must belong to this company and payout month.'; end if;
  perform 1 from public.helpers helper where helper.company_id = p_company_id and helper.id in (
    select item.helper_id from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.id = any(v_ids)
  ) order by helper.id for update;
  perform 1 from public.helper_payout_payment_batches batch
  where batch.company_id = p_company_id and batch.id in (
    select distinct item.batch_id from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.id = any(v_ids)
  ) order by batch.id for update;
  perform 1 from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = any(v_ids) order by item.id for update;
  select count(*)::integer into v_matching from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = any(v_ids)
    and item.period_start = p_period_start and item.period_end = p_period_end
    and item.status = 'processing';
  if v_matching <> v_count then
    raise exception 'Every selected payment must still be Payment Processing. No payments were cancelled.';
  end if;
  select item.* into v_first from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = any(v_ids) order by item.id limit 1;
  select array_agg(distinct item.batch_id order by item.batch_id) into v_batches
  from public.helper_payout_payment_items item
  where item.company_id = p_company_id and item.id = any(v_ids);
  v_now := clock_timestamp();
  perform set_config('app.helper_payout_payment_mutation', 'allowed', true);
  update public.helper_payout_payment_items item set status = 'cancelled',
    bank_response_status = 'MANUAL_CANCELLED', utr_cin = null,
    bank_processing_remarks = v_remarks, response_import_id = null,
    finalized_by = p_actor_user_id, finalized_at = v_now, updated_at = v_now
  where item.company_id = p_company_id and item.id = any(v_ids) and item.status = 'processing';
  with counts as (
    select item.batch_id,
      count(*) filter (where item.status = 'processing')::integer processing,
      count(*) filter (where item.status in ('paid','cancelled','failed'))::integer terminal
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.batch_id = any(v_batches)
    group by item.batch_id
  )
  update public.helper_payout_payment_batches batch set
    status = case when counts.processing = 0 then 'completed'
      when counts.terminal > 0 then 'partially_finalized' else 'processing' end,
    updated_at = v_now,
    completed_at = case when counts.processing = 0 then coalesce(batch.completed_at, v_now) else null end
  from counts where batch.company_id = p_company_id and batch.id = counts.batch_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_item_id', item.id, 'batch_id', item.batch_id, 'reference_no', item.reference_no,
    'outcome', 'cancelled', 'remarks', v_remarks, 'batch_status', batch.status, 'replayed', false
  ) order by item.id), '[]'::jsonb) into v_items
  from public.helper_payout_payment_items item
  join public.helper_payout_payment_batches batch on batch.company_id = item.company_id and batch.id = item.batch_id
  where item.company_id = p_company_id and item.id = any(v_ids);
  insert into public.helper_payout_payment_events(
    company_id, batch_id, payment_item_id, event_type, event_data, actor_user_id
  )
  select p_company_id, item.batch_id, item.id, 'payment_cancelled_manually',
    jsonb_build_object('payment_item_id', item.id, 'batch_id', item.batch_id,
      'reference_no', item.reference_no, 'outcome', 'cancelled',
      'remarks', v_remarks, 'batch_status', batch.status, 'replayed', false),
    p_actor_user_id
  from public.helper_payout_payment_items item
  join public.helper_payout_payment_batches batch on batch.company_id = item.company_id and batch.id = item.batch_id
  where item.company_id = p_company_id and item.id = any(v_ids)
  order by item.id;
  v_result := jsonb_build_object(
    'payment_item_ids', to_jsonb(v_ids), 'period_start', p_period_start,
    'period_end', p_period_end, 'remarks', v_remarks, 'cancelled', v_count,
    'items', v_items, 'replayed', false
  );
  insert into public.helper_payout_payment_events(
    company_id, batch_id, payment_item_id, operation_id, event_type, event_data, actor_user_id
  ) values (p_company_id, v_first.batch_id, v_first.id, p_operation_id,
    'payment_cancelled_bulk', v_result, p_actor_user_id);
  return v_result;
end
$function$;

create or replace function public.helper_get_payout_payment_redownload(
  p_company_id uuid, p_payment_item_ids uuid[], p_period_start date, p_period_end date
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_ids uuid[];
  v_count integer;
  v_matching integer;
  v_items jsonb;
begin
  if p_company_id is null then raise exception 'Company is required.'; end if;
  if p_period_start is null or p_period_end is null or extract(day from p_period_start) <> 1
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then raise exception 'Choose one complete payout month.'; end if;
  if p_payment_item_ids is null or cardinality(p_payment_item_ids) < 1
    or array_position(p_payment_item_ids, null) is not null
  then raise exception 'Select at least one processing payment.'; end if;
  select array_agg(distinct requested.id order by requested.id) into v_ids
  from unnest(p_payment_item_ids) requested(id);
  v_count := cardinality(v_ids);
  if v_count <> cardinality(p_payment_item_ids) then raise exception 'Each processing payment may be selected only once.'; end if;
  select count(*)::integer into v_matching from public.helper_payout_payment_items item
  join public.helper_payout_payment_batches batch on batch.company_id = item.company_id and batch.id = item.batch_id
  where item.company_id = p_company_id and item.id = any(v_ids)
    and item.period_start = p_period_start and item.period_end = p_period_end
    and item.status = 'processing' and batch.status in ('processing','partially_finalized')
    and batch.file_type_snapshot = 'fedone';
  if v_matching <> v_count then
    raise exception 'Every selected payment must still be Payment Processing in this company and month.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_item_id', item.id, 'batch_id', item.batch_id, 'batch_status', batch.status,
    'generated_at', batch.generated_at, 'period_start', item.period_start,
    'period_end', item.period_end, 'value_date', batch.value_date,
    'debit_account_no', batch.debit_account_no_snapshot, 'bank_code', batch.bank_code_snapshot,
    'file_type', batch.file_type_snapshot, 'reference_no', item.reference_no,
    'instruction_amount', item.instruction_amount, 'bank_account_no', item.bank_account_no_snapshot,
    'ifsc', item.ifsc_snapshot, 'beneficiary_name', item.beneficiary_name_snapshot,
    'beneficiary_email', item.beneficiary_email_snapshot, 'location_id', item.location_id_snapshot,
    'location_code', item.location_code_snapshot, 'credit_remarks', item.credit_remarks_snapshot,
    'debit_remarks', item.debit_remarks_snapshot
  ) order by batch.generated_at, batch.id, item.reference_no, item.id), '[]'::jsonb)
  into v_items from public.helper_payout_payment_items item
  join public.helper_payout_payment_batches batch on batch.company_id = item.company_id and batch.id = item.batch_id
  where item.company_id = p_company_id and item.id = any(v_ids)
    and item.period_start = p_period_start and item.period_end = p_period_end
    and item.status = 'processing' and batch.status in ('processing','partially_finalized');
  return jsonb_build_object('payment_count', v_count, 'period_start', p_period_start,
    'period_end', p_period_end, 'items', v_items);
end
$function$;

create or replace function public.helper_payout_payment_is_processing(
  p_company_id uuid, p_helper_id uuid, p_period_start date, p_period_end date
)
returns boolean language sql security definer set search_path = '' stable as $function$
  select exists (
    select 1 from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = p_helper_id
      and item.status = 'processing'
      and daterange(item.period_start, item.period_end, '[]')
        && daterange(p_period_start, p_period_end, '[]')
  );
$function$;

-- Publication/review state is location scoped. Callers acquire the Helper
-- row (when they have one) and the company payout mutex before this read-only
-- assertion, so it closes the create-vs-publish race without adding a
-- row-lock inversion below review/publication rows.
create or replace function public.helper_assert_payout_not_processing(
  p_company_id uuid,
  p_helper_id uuid,
  p_station_id uuid,
  p_period_start date,
  p_period_end date
)
returns void
language plpgsql
security definer
set search_path = ''
stable
as $function$
begin
  if p_company_id is null or p_helper_id is null or p_station_id is null
    or p_period_start is null or p_period_end is null
  then
    return;
  end if;
  if exists (
    select 1
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.helper_id = p_helper_id
      and item.location_id_snapshot = p_station_id
      and item.status = 'processing'
      and daterange(item.period_start, item.period_end, '[]')
        && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'Helper payout cannot change while its bank payment is Payment Processing.';
  end if;
end
$function$;

-- The dependency-stamp trigger from the publication migration runs first
-- (`..._00_dependencies`) and owns the canonical Helper -> company locks.
-- This later BEFORE trigger performs only the exact authoritative check.
create or replace function public.guard_helper_payout_publication_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.helper_assert_payout_not_processing(
    new.company_id, new.helper_id, new.station_id,
    new.period_start, new.period_end
  );
  return new;
end
$function$;

drop trigger if exists helper_payout_publications_01_processing_guard
  on public.helper_payout_publications;
create trigger helper_payout_publications_01_processing_guard
before insert on public.helper_payout_publications
for each row execute function public.guard_helper_payout_publication_processing();

-- Review rows are tuple-locked before row triggers run. The existing service
-- RPCs serialize through the company payout mutex, so this trigger must remain
-- a read-only assertion (the same pattern as the Workforce review guard).
create or replace function public.guard_helper_payout_review_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_company uuid;
  v_old_helper uuid;
  v_old_station uuid;
  v_old_start date;
  v_old_end date;
  v_new_company uuid;
  v_new_helper uuid;
  v_new_station uuid;
  v_new_start date;
  v_new_end date;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.subject_type = 'helper' then
    v_old_company := old.company_id;
    v_old_helper := old.subject_id;
    v_old_station := old.location_id;
    v_old_start := old.period_start;
    v_old_end := old.period_end;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.subject_type = 'helper' then
    v_new_company := new.company_id;
    v_new_helper := new.subject_id;
    v_new_station := new.location_id;
    v_new_start := new.period_start;
    v_new_end := new.period_end;
  end if;

  if tg_op = 'UPDATE'
    and new.status is not distinct from old.status
    and new.calculation_snapshot is not distinct from old.calculation_snapshot
    and (v_new_company, v_new_helper, v_new_station, v_new_start, v_new_end)
      is not distinct from
      (v_old_company, v_old_helper, v_old_station, v_old_start, v_old_end)
  then
    return new;
  end if;

  perform public.helper_assert_payout_not_processing(
    v_old_company, v_old_helper, v_old_station, v_old_start, v_old_end
  );
  if (v_new_company, v_new_helper, v_new_station, v_new_start, v_new_end)
    is distinct from
    (v_old_company, v_old_helper, v_old_station, v_old_start, v_old_end)
  then
    perform public.helper_assert_payout_not_processing(
      v_new_company, v_new_helper, v_new_station, v_new_start, v_new_end
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists workforce_payout_review_submissions_01_helper_processing_guard
  on public.workforce_payout_review_submissions;
create trigger workforce_payout_review_submissions_01_helper_processing_guard
before insert or update or delete on public.workforce_payout_review_submissions
for each row execute function public.guard_helper_payout_review_processing();

-- The shared review-transition RPC already serializes through the company
-- payout mutex. Extend its post-mutex assertion to Helper/location payments;
-- direct review writes remain revoked by the Workforce bank migration.
do $patch_helper_review_transition$
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
    raise exception 'Could not install the Helper bank-processing assertion in workforce_transition_payout_review_status.';
  end if;
  v_definition := overlay(
    v_definition placing E'\n\n  if v_subject_type = ''helper'' then\n    perform public.helper_assert_payout_not_processing(\n      p_company_id, p_subject_id, p_location_id, p_period_start, p_period_end\n    );\n  end if;'
    from v_position + length(v_marker) for 0
  );
  execute v_definition;
end
$patch_helper_review_transition$;

-- Company-wide payout policy is shared by Workforce and Helper calculations.
-- Replacing this established predicate extends every existing policy writer
-- that already calls it without changing those APIs or their lock order.
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

    union all

    select 1
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.status = 'processing'
      and item.period_end >= p_effective_from
      and (p_effective_until is null or item.period_start < p_effective_until)
  );
$function$;

-- Replace the dependency-free hook installed by the Helper payout-input
-- migration. Input edits are location scoped, so a processing instruction at
-- another Helper location must not freeze this row.
create or replace function public.helper_payout_input_processing_locked(
  p_company_id uuid,
  p_helper_id uuid,
  p_station_id uuid,
  p_effective_from date,
  p_effective_to date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and item.helper_id = p_helper_id
      and item.location_id_snapshot = p_station_id
      and item.status = 'processing'
      and daterange(item.period_start, item.period_end, '[]')
        && daterange(p_effective_from, coalesce(p_effective_to, p_effective_from), '[]')
  );
$function$;

-- Helper payment-method/rate allocations are payout inputs too. Block only
-- allocation changes whose old or new effective period intersects an exact
-- Helper/location bank instruction that is still Payment Processing. This is
-- deliberately separate from provider/ID mapping locks, which remain
-- Workforce-only.
create or replace function public.guard_helper_payout_allocation_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_locked boolean := false;
  v_new_locked boolean := false;
begin
  if tg_op = 'UPDATE' and row(
      new.company_id, new.helper_id, new.station_id,
      new.station_code_snapshot, new.designation_id,
      new.designation_code_snapshot, new.designation_name_snapshot,
      new.payment_method_id, new.payment_values, new.payment_components,
      new.effective_from, new.effective_to, new.status
    ) is not distinct from row(
      old.company_id, old.helper_id, old.station_id,
      old.station_code_snapshot, old.designation_id,
      old.designation_code_snapshot, old.designation_name_snapshot,
      old.payment_method_id, old.payment_values, old.payment_components,
      old.effective_from, old.effective_to, old.status
    )
  then
    return new;
  end if;

  -- Every allocation writer must participate in the same Helper-first lock
  -- order as bank creation. This closes the check/insert window even for
  -- future service writers that do not already lock their subject Helper.
  if tg_op = 'INSERT' then
    perform 1 from public.helpers helper
    where helper.company_id = new.company_id and helper.id = new.helper_id
    order by helper.company_id, helper.id for update;
  elsif tg_op = 'DELETE' then
    perform 1 from public.helpers helper
    where helper.company_id = old.company_id and helper.id = old.helper_id
    order by helper.company_id, helper.id for update;
  else
    perform 1 from public.helpers helper
    where (helper.company_id, helper.id) in (
      (old.company_id, old.helper_id),
      (new.company_id, new.helper_id)
    )
    order by helper.company_id, helper.id for update;
  end if;

  if tg_op <> 'INSERT' and old.status <> 'cancelled' then
    select exists (
      select 1
      from public.helper_payout_payment_items item
      where item.company_id = old.company_id
        and item.helper_id = old.helper_id
        and item.location_id_snapshot = old.station_id
        and item.status = 'processing'
        and daterange(item.period_start, item.period_end, '[]')
          && daterange(old.effective_from, coalesce(old.effective_to, 'infinity'::date), '[]')
    ) into v_old_locked;
  end if;

  if tg_op <> 'DELETE' and new.status <> 'cancelled' then
    select exists (
      select 1
      from public.helper_payout_payment_items item
      where item.company_id = new.company_id
        and item.helper_id = new.helper_id
        and item.location_id_snapshot = new.station_id
        and item.status = 'processing'
        and daterange(item.period_start, item.period_end, '[]')
          && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
    ) into v_new_locked;
  end if;

  if v_old_locked or v_new_locked then
    raise exception 'Helper payment allocation cannot change while its payout is Payment Processing.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger helper_payment_allocations_90_processing_guard
before insert or update or delete on public.helper_payment_allocations
for each row execute function public.guard_helper_payout_allocation_processing();

-- A Helper profile is itself a payout input (joining date, PAN, biometric ID,
-- active state and bank identity). The row being updated/deleted is already
-- locked by PostgreSQL before this BEFORE trigger runs, so taking the company
-- mutex here preserves the canonical Helper -> company order used by bank
-- creation.
create or replace function public.guard_helper_profile_payout_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company uuid;
  v_audit_keys text[] := array['created_at','updated_at','created_by','updated_by'];
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(new) - v_audit_keys) is not distinct from (to_jsonb(old) - v_audit_keys)
  then
    return new;
  end if;

  for v_company in
    select distinct scope.company_id
    from (values (old.company_id),
      (case when tg_op = 'UPDATE' then new.company_id else null end)
    ) scope(company_id)
    where scope.company_id is not null
    order by scope.company_id
  loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;

  if exists (
    select 1
    from public.helper_payout_payment_items item
    where item.status = 'processing'
      and (
        (item.company_id = old.company_id and item.helper_id = old.id)
        or (tg_op = 'UPDATE' and item.company_id = new.company_id and item.helper_id = new.id)
      )
  ) then
    raise exception 'Helper profile cannot change while its payout is Payment Processing.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists helpers_90_payout_processing_guard on public.helpers;
create trigger helpers_90_payout_processing_guard
before update or delete on public.helpers
for each row execute function public.guard_helper_profile_payout_processing();

-- Shared masters and PAN/Aadhaar verification rows are statement-guarded so
-- multi-row and cross-company writes take affected company mutexes in
-- deterministic order. Do not take Helper row locks after a master/source row
-- has already been locked: allocation writers use Helper -> master ordering.
-- `helper_verification` filters the shared verification table to the one state
-- consumed by Helper payout math.
create or replace function public.guard_helper_payout_company_source_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_companies uuid[] := '{}'::uuid[];
  v_company uuid;
  v_mode text := coalesce(tg_argv[0], 'all');
begin
  if tg_op = 'INSERT' then
    select coalesce(array_agg(distinct (row_json ->> 'company_id')::uuid
      order by (row_json ->> 'company_id')::uuid), '{}'::uuid[])
    into v_companies
    from (select to_jsonb(row_data) row_json from helper_processing_new_rows row_data) changed
    where nullif(row_json ->> 'company_id', '') is not null
      and (v_mode <> 'helper_verification' or (
        lower(coalesce(row_json ->> 'profile_type', '')) = 'worker'
        and lower(coalesce(row_json ->> 'kind', '')) = 'pan_aadhaar'
      ));
  elsif tg_op = 'DELETE' then
    select coalesce(array_agg(distinct (row_json ->> 'company_id')::uuid
      order by (row_json ->> 'company_id')::uuid), '{}'::uuid[])
    into v_companies
    from (select to_jsonb(row_data) row_json from helper_processing_old_rows row_data) changed
    where nullif(row_json ->> 'company_id', '') is not null
      and (v_mode <> 'helper_verification' or (
        lower(coalesce(row_json ->> 'profile_type', '')) = 'worker'
        and lower(coalesce(row_json ->> 'kind', '')) = 'pan_aadhaar'
      ));
  else
    select coalesce(array_agg(distinct (row_json ->> 'company_id')::uuid
      order by (row_json ->> 'company_id')::uuid), '{}'::uuid[])
    into v_companies
    from (
      select to_jsonb(row_data) row_json from helper_processing_old_rows row_data
      union all
      select to_jsonb(row_data) row_json from helper_processing_new_rows row_data
    ) changed
    where nullif(row_json ->> 'company_id', '') is not null
      and (v_mode <> 'helper_verification' or (
        lower(coalesce(row_json ->> 'profile_type', '')) = 'worker'
        and lower(coalesce(row_json ->> 'kind', '')) = 'pan_aadhaar'
      ));
  end if;

  if cardinality(v_companies) = 0 then return null; end if;
  foreach v_company in array v_companies loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;
  if exists (
    select 1 from public.helper_payout_payment_items item
    where item.company_id = any(v_companies) and item.status = 'processing'
  ) then
    raise exception 'Shared payout configuration cannot change while a Helper payment is Processing.';
  end if;
  return null;
end
$function$;

-- Biometric ownership and attendance facts can affect any Helper sharing the
-- same enrolment ID. Conservatively freeze the affected company/date scopes;
-- this avoids an ownership race while still allowing unrelated months.
create or replace function public.guard_helper_payout_period_source_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scopes jsonb := '[]'::jsonb;
  v_companies uuid[] := '{}'::uuid[];
  v_company uuid;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2]
    )), '[]'::jsonb) into v_scopes
    from (select to_jsonb(row_data) row_json from helper_processing_new_rows row_data) changed;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2]
    )), '[]'::jsonb) into v_scopes
    from (select to_jsonb(row_data) row_json from helper_processing_old_rows row_data) changed;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2]
    )), '[]'::jsonb) into v_scopes
    from (
      select to_jsonb(row_data) row_json from helper_processing_old_rows row_data
      union all
      select to_jsonb(row_data) row_json from helper_processing_new_rows row_data
    ) changed;
  end if;

  select coalesce(array_agg(distinct (scope.value ->> 'company_id')::uuid
    order by (scope.value ->> 'company_id')::uuid), '{}'::uuid[])
  into v_companies
  from jsonb_array_elements(v_scopes) scope(value)
  where nullif(scope.value ->> 'company_id', '') is not null
    and nullif(scope.value ->> 'effective_from', '') is not null;
  if cardinality(v_companies) = 0 then return null; end if;

  foreach v_company in array v_companies loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;
  if exists (
    select 1
    from public.helper_payout_payment_items item
    join jsonb_array_elements(v_scopes) scope(value)
      on item.company_id = (scope.value ->> 'company_id')::uuid
     and daterange(item.period_start, item.period_end, '[]')
       && daterange(
         (scope.value ->> 'effective_from')::date,
         coalesce(nullif(scope.value ->> 'effective_to', '')::date, 'infinity'::date),
         '[]'
       )
    where item.status = 'processing'
  ) then
    raise exception 'Biometric or attendance data cannot change while an overlapping Helper payment is Processing.';
  end if;
  return null;
end
$function$;

create or replace function public.guard_helper_payout_source_truncate_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company uuid;
begin
  for v_company in select company.id from public.companies company order by company.id loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;
  if exists (select 1 from public.helper_payout_payment_items item where item.status = 'processing') then
    raise exception 'Helper payout source data cannot be truncated while a payment is Processing.';
  end if;
  return null;
end
$function$;

do $helper_shared_processing_guards$
declare
  v_table text;
begin
  foreach v_table in array array[
    'stations',
    'workforce_deduction_heads',
    'workforce_additional_payment_fields',
    'payment_method_components',
    'payment_fields',
    'payment_methods'
  ] loop
    execute format('drop trigger if exists helper_payout_processing_insert on public.%I', v_table);
    execute format(
      'create trigger helper_payout_processing_insert after insert on public.%I '
      || 'referencing new table as helper_processing_new_rows for each statement '
      || 'execute function public.guard_helper_payout_company_source_processing()',
      v_table
    );
    execute format('drop trigger if exists helper_payout_processing_update on public.%I', v_table);
    execute format(
      'create trigger helper_payout_processing_update after update on public.%I '
      || 'referencing old table as helper_processing_old_rows new table as helper_processing_new_rows '
      || 'for each statement execute function public.guard_helper_payout_company_source_processing()',
      v_table
    );
    execute format('drop trigger if exists helper_payout_processing_delete on public.%I', v_table);
    execute format(
      'create trigger helper_payout_processing_delete after delete on public.%I '
      || 'referencing old table as helper_processing_old_rows for each statement '
      || 'execute function public.guard_helper_payout_company_source_processing()',
      v_table
    );
  end loop;
end
$helper_shared_processing_guards$;

drop trigger if exists connect_profile_verifications_helper_processing_insert
  on public.connect_profile_verifications;
create trigger connect_profile_verifications_helper_processing_insert
after insert on public.connect_profile_verifications
referencing new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_company_source_processing('helper_verification');
drop trigger if exists connect_profile_verifications_helper_processing_update
  on public.connect_profile_verifications;
create trigger connect_profile_verifications_helper_processing_update
after update on public.connect_profile_verifications
referencing old table as helper_processing_old_rows new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_company_source_processing('helper_verification');
drop trigger if exists connect_profile_verifications_helper_processing_delete
  on public.connect_profile_verifications;
create trigger connect_profile_verifications_helper_processing_delete
after delete on public.connect_profile_verifications
referencing old table as helper_processing_old_rows
for each statement execute function public.guard_helper_payout_company_source_processing('helper_verification');

drop trigger if exists biometric_enrolments_helper_processing_insert on public.biometric_enrolments;
create trigger biometric_enrolments_helper_processing_insert
after insert on public.biometric_enrolments
referencing new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'effective_from', 'effective_to'
);
drop trigger if exists biometric_enrolments_helper_processing_update on public.biometric_enrolments;
create trigger biometric_enrolments_helper_processing_update
after update on public.biometric_enrolments
referencing old table as helper_processing_old_rows new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'effective_from', 'effective_to'
);
drop trigger if exists biometric_enrolments_helper_processing_delete on public.biometric_enrolments;
create trigger biometric_enrolments_helper_processing_delete
after delete on public.biometric_enrolments
referencing old table as helper_processing_old_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'effective_from', 'effective_to'
);

drop trigger if exists attendance_daily_helper_processing_insert on public.attendance_daily;
create trigger attendance_daily_helper_processing_insert
after insert on public.attendance_daily
referencing new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'punch_date', 'punch_date'
);
drop trigger if exists attendance_daily_helper_processing_update on public.attendance_daily;
create trigger attendance_daily_helper_processing_update
after update on public.attendance_daily
referencing old table as helper_processing_old_rows new table as helper_processing_new_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'punch_date', 'punch_date'
);
drop trigger if exists attendance_daily_helper_processing_delete on public.attendance_daily;
create trigger attendance_daily_helper_processing_delete
after delete on public.attendance_daily
referencing old table as helper_processing_old_rows
for each statement execute function public.guard_helper_payout_period_source_processing(
  'company_id', 'punch_date', 'punch_date'
);

do $helper_source_truncate_guards$
declare
  v_table text;
begin
  foreach v_table in array array[
    'helpers',
    'stations',
    'connect_profile_verifications',
    'biometric_enrolments',
    'attendance_daily',
    'helper_payment_allocations',
    'helper_payout_attendance_values',
    'helper_additional_payment_values',
    'helper_payout_deduction_values',
    'workforce_payment_settings',
    'workforce_deduction_heads',
    'workforce_additional_payment_fields',
    'payment_method_components',
    'payment_fields',
    'payment_methods'
  ] loop
    execute format('drop trigger if exists helper_payout_processing_truncate on public.%I', v_table);
    execute format(
      'create trigger helper_payout_processing_truncate before truncate on public.%I '
      || 'for each statement execute function public.guard_helper_payout_source_truncate_processing()',
      v_table
    );
  end loop;
end
$helper_source_truncate_guards$;

comment on table public.helper_payout_payment_items is
  'Immutable, location-scoped Helper bank instructions. Paid amounts reduce only the same Helper/location monthly balance.';
comment on table public.payout_bank_paid_transaction_registry is
  'Cross-audience uniqueness registry for normalized paid bank UTR/CIN values.';
comment on function public.helper_preview_payout_payment_rows(uuid,date,date,jsonb) is
  'Returns authoritative Helper publication balances and bank eligibility for selected Helper/location rows.';
comment on function public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb) is
  'Creates one versioned FedOne instruction per eligible Helper/location row from the latest immutable Helper payout publication.';
comment on function public.helper_replay_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date) is
  'Replays a committed immutable Helper bank batch before mutable live payout dependencies are reloaded.';
comment on function public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb) is
  'Validates an exact FedOne response and finalizes matching Helper payment instructions idempotently.';
comment on function public.helper_get_payout_payment_redownload(uuid,uuid[],date,date) is
  'Returns immutable FedOne snapshots for exactly the selected processing Helper payment items.';
comment on function public.helper_cancel_payout_payment_items(uuid,uuid,uuid,uuid[],date,date,text) is
  'Atomically cancels selected processing Helper payment instructions with an audit remark.';
comment on function public.helper_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text) is
  'Changes one processing Helper payment instruction to manually failed or cancelled.';
comment on function public.helper_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text) is
  'Records an idempotent audited Helper/month payment hold or release.';
comment on function public.helper_payout_input_processing_locked(uuid,uuid,uuid,date,date) is
  'Returns true only when the same Helper/location has an overlapping Payment Processing bank instruction.';
comment on function public.guard_helper_payout_allocation_processing() is
  'Blocks payout-affecting Helper allocation changes for the exact Helper/location/period while a bank payment is processing.';
comment on function public.guard_helper_profile_payout_processing() is
  'Freezes payout-affecting Helper profile fields while any bank instruction for that Helper is processing.';
comment on function public.guard_helper_payout_company_source_processing() is
  'Freezes shared payment definitions and Helper PAN verification while affected companies have processing Helper payments.';
comment on function public.guard_helper_payout_period_source_processing() is
  'Freezes biometric ownership and attendance facts only for company/date scopes with processing Helper payments.';
comment on function public.helper_assert_payout_not_processing(uuid,uuid,uuid,date,date) is
  'Rejects exact Helper/location payout publication or review changes while an overlapping bank instruction is processing.';

revoke all on function public.guard_helper_payout_payment_batch_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_bank_text(text)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_payment_item_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_payment_append_only()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_payout_bank_paid_transaction_registry()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_payout_bank_paid_transaction()
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_payment_reference(uuid,text,date,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_payment_row_candidates(uuid,date,date,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.helper_payout_payment_batch_result(uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.helper_preview_payout_payment_rows(uuid,date,date,jsonb)
  from public, anon, authenticated;
revoke all on function public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)
  from public, anon, authenticated;
revoke all on function public.helper_replay_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date)
  from public, anon, authenticated;
revoke all on function public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.helper_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.helper_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text)
  from public, anon, authenticated;
revoke all on function public.helper_cancel_payout_payment_items(uuid,uuid,uuid,uuid[],date,date,text)
  from public, anon, authenticated;
revoke all on function public.helper_get_payout_payment_redownload(uuid,uuid[],date,date)
  from public, anon, authenticated;
revoke all on function public.helper_payout_payment_is_processing(uuid,uuid,date,date)
  from public, anon, authenticated;
revoke all on function public.helper_payout_input_processing_locked(uuid,uuid,uuid,date,date)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_allocation_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_profile_payout_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_company_source_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_period_source_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_source_truncate_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.helper_assert_payout_not_processing(uuid,uuid,uuid,date,date)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_publication_processing()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_helper_payout_review_processing()
  from public, anon, authenticated, service_role;

grant execute on function public.helper_preview_payout_payment_rows(uuid,date,date,jsonb)
  to service_role;
grant execute on function public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)
  to service_role;
grant execute on function public.helper_replay_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date)
  to service_role;
grant execute on function public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)
  to service_role;
grant execute on function public.helper_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text)
  to service_role;
grant execute on function public.helper_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text)
  to service_role;
grant execute on function public.helper_cancel_payout_payment_items(uuid,uuid,uuid,uuid[],date,date,text)
  to service_role;
grant execute on function public.helper_get_payout_payment_redownload(uuid,uuid[],date,date)
  to service_role;
grant execute on function public.helper_payout_payment_is_processing(uuid,uuid,date,date)
  to service_role;
grant execute on function public.helper_payout_input_processing_locked(uuid,uuid,uuid,date,date)
  to service_role;

notify pgrst, 'reload schema';

commit;
