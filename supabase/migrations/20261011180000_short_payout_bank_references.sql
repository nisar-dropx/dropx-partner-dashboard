begin;

-- Bank references are operator-facing identifiers. Keep the profile DropX ID
-- readable while removing punctuation that Federal Bank does not accept.
create or replace function public.payout_bank_reference_dropx_canonical(p_value text)
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
  v_normalized_id text := public.payout_bank_reference_dropx_canonical(p_dropx_id);
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

  v_reference := 'WF' || v_normalized_id
    || pg_catalog.to_char(p_period_start, 'MMYYYY')
    || 'V' || p_version::text;
  if length(v_reference) > 64 then
    raise exception 'DropX ID is too long for the bank reference format.';
  end if;
  if v_reference !~ '^WF[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$' then
    raise exception 'Unable to build a valid Workforce payment reference.';
  end if;
  return v_reference;
end
$function$;

-- Keep the existing signature because the Helper profile UUID remains an
-- input-integrity guard for every existing caller. It is intentionally no
-- longer embedded in the customer reference.
create or replace function public.helper_payout_payment_reference(
  p_helper_id uuid,
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
  v_normalized_id text := public.payout_bank_reference_dropx_canonical(p_dropx_id);
  v_reference text;
begin
  if p_helper_id is null or v_normalized_id = ''
    or p_period_start is null or extract(day from p_period_start) <> 1
    or p_version is null or p_version < 1
  then
    raise exception 'A valid Helper profile, Helper ID, payout month and payment version are required.';
  end if;

  v_reference := 'HP' || v_normalized_id
    || pg_catalog.to_char(p_period_start, 'MMYYYY')
    || 'V' || p_version::text;
  if length(v_reference) > 64 then
    raise exception 'DropX ID is too long for the Helper payment reference format.';
  end if;
  if v_reference !~ '^HP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$' then
    raise exception 'Unable to build a valid Helper payment reference.';
  end if;
  return v_reference;
end
$function$;

-- Version allocation compares the bank-normalized DropX ID across profiles.
-- Keep that collision check index-backed as each payment ledger grows.
create index if not exists workforce_payout_payment_items_reference_version_lookup_idx
  on public.workforce_payout_payment_items (
    company_id,
    public.payout_bank_reference_dropx_canonical(dropx_id_snapshot),
    period_start,
    period_end,
    payment_version desc
  );

create index if not exists helper_payout_payment_items_reference_version_lookup_idx
  on public.helper_payout_payment_items (
    company_id,
    public.payout_bank_reference_dropx_canonical(dropx_id_snapshot),
    period_start,
    period_end,
    payment_version desc
  );

-- Existing WP references are immutable bank/audit evidence. Accept both the
-- historical WP namespace and the new WF namespace; only new calls generate
-- WF references.
alter table public.workforce_payout_payment_items
  drop constraint if exists workforce_payout_payment_items_reference_check;
alter table public.workforce_payout_payment_items
  add constraint workforce_payout_payment_items_reference_check check (
    reference_no = public.workforce_payout_bank_reference_canonical(reference_no)
    and reference_no ~ '^(WP|WF)[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'
    and length(reference_no) <= 64
  ) not valid;
alter table public.workforce_payout_payment_items
  validate constraint workforce_payout_payment_items_reference_check;

-- The Workforce ledger finalizer validates the namespace before matching the
-- immutable stored reference. Widen only that validation to WP|WF so old bank
-- responses and new bank responses remain finalizable through the same RPC.
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$v_reference !~ '^WP[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'$old$, chr(13), '');
  v_new constant text := replace($new$v_reference !~ '^(WP|WF)[A-Z0-9]+(0[1-9]|1[0-2])[0-9]{4}V[1-9][0-9]*$'$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select pg_catalog.replace(pg_catalog.pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception 'Unexpected Workforce bank-response reference validation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;

-- Reference versions form a company/month namespace after removing DropX-ID
-- punctuation. Allocate above every historical version for either the same
-- profile or another profile with the same bank-normalized DropX ID. The
-- creators already hold the shared company payment mutex, so this remains
-- race-safe while keeping the short reference exact and deterministic.
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$    select coalesce(max(item.payment_version), 0) + 1
    into v_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;$old$, chr(13), '');
  v_new constant text := replace($new$    select coalesce(max(item.payment_version), 0) + 1
    into v_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and (
        item.workforce_id = v_workforce_id
        or public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot)
          = public.payout_bank_reference_dropx_canonical(v_worker.dropx_id)
      )
      and item.period_start = p_period_start
      and item.period_end = p_period_end;$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select pg_catalog.replace(pg_catalog.pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception 'Unexpected Workforce row-bank version allocation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;

-- Retain collision safety for the older service-only profile batch RPC as
-- well, even though the current application uses row-level selection.
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$    select coalesce(max(item.payment_version), 0)
    into v_next_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and item.workforce_id = v_workforce_id
      and item.period_start = p_period_start
      and item.period_end = p_period_end;$old$, chr(13), '');
  v_new constant text := replace($new$    select coalesce(max(item.payment_version), 0)
    into v_next_version
    from public.workforce_payout_payment_items item
    where item.company_id = p_company_id
      and (
        item.workforce_id = v_workforce_id
        or public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot)
          = public.payout_bank_reference_dropx_canonical(v_worker.dropx_id)
      )
      and item.period_start = p_period_start
      and item.period_end = p_period_end;$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select pg_catalog.replace(pg_catalog.pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception 'Unexpected Workforce profile-bank version allocation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;

do $patch$
declare
  v_signature regprocedure :=
    'public.helper_create_payout_payment_row_batch(uuid,uuid,uuid,text,uuid,date,date,date,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$    select coalesce(max(item.payment_version), 0) + 1 into v_version
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id and item.helper_id = v_candidate.workforce_id
      and item.period_start = p_period_start and item.period_end = p_period_end;$old$, chr(13), '');
  v_new constant text := replace($new$    select coalesce(max(item.payment_version), 0) + 1 into v_version
    from public.helper_payout_payment_items item
    where item.company_id = p_company_id
      and (
        item.helper_id = v_candidate.workforce_id
        or public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot)
          = public.payout_bank_reference_dropx_canonical(v_helper.dropx_id)
      )
      and item.period_start = p_period_start and item.period_end = p_period_end;$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select pg_catalog.replace(pg_catalog.pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception 'Unexpected Helper bank version allocation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;

comment on function public.workforce_payout_payment_reference(text,date,integer) is
  'Builds new Workforce bank references as WF plus normalized DropX ID, MMYYYY and payment version. Historical WP references remain valid stored evidence.';
comment on function public.helper_payout_payment_reference(uuid,text,date,integer) is
  'Builds new Helper bank references as HP plus normalized DropX ID, MMYYYY and payment version without embedding the Helper UUID.';

notify pgrst, 'reload schema';

commit;
