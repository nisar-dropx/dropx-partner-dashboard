begin;

-- Beneficiary bank fields are operator-owned master data. Bank-file eligibility
-- requires both values to be present, but it must not apply local account/IFSC
-- syntax rules that are stricter than the bank's own processing rules. Keep
-- whitespace/invisible-character canonicalization, immutable snapshots, exact
-- response matching, positive amounts and payment-reference validation intact.

-- verification-section: workforce-row-candidate:start
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure;
  v_definition text;
  v_account_old constant text := replace($old$    if public.workforce_payout_bank_account_canonical(v_worker.bank_account_no)
      !~ '^[A-Z0-9]{4,30}$'
    then
      eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format('Bank account for Workforce ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
$old$, chr(13), '');
  v_ifsc_old constant text := replace($old$    if public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code)
      !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    then
      eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format('IFSC for Workforce ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
$old$, chr(13), '');
  v_account_count integer;
  v_ifsc_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;
  v_account_count := (length(v_definition) - length(replace(v_definition, v_account_old, '')))
    / length(v_account_old);
  v_ifsc_count := (length(v_definition) - length(replace(v_definition, v_ifsc_old, '')))
    / length(v_ifsc_old);
  if v_account_count <> 1 or v_ifsc_count <> 1 then
    raise exception
      'Unexpected Workforce beneficiary validation structure (account %, IFSC %).',
      v_account_count, v_ifsc_count;
  end if;
  v_definition := replace(v_definition, v_account_old, '');
  v_definition := replace(v_definition, v_ifsc_old, '');
  execute v_definition;
end
$patch$;
-- verification-section: workforce-row-candidate:end

-- Keep the additive profile-wide RPC consistent while older application
-- instances are still allowed to call it during the row-selection rollout.
-- verification-section: workforce-profile-candidate:start
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure;
  v_definition text;
  v_account_old constant text := replace($old$    if public.workforce_payout_bank_account_canonical(v_worker.bank_account_no)
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
$old$, chr(13), '');
  v_ifsc_old constant text := replace($old$    if public.workforce_payout_bank_ifsc_canonical(v_worker.ifsc_code)
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
$old$, chr(13), '');
  v_account_count integer;
  v_ifsc_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;
  v_account_count := (length(v_definition) - length(replace(v_definition, v_account_old, '')))
    / length(v_account_old);
  v_ifsc_count := (length(v_definition) - length(replace(v_definition, v_ifsc_old, '')))
    / length(v_ifsc_old);
  if v_account_count <> 1 or v_ifsc_count <> 1 then
    raise exception
      'Unexpected legacy Workforce beneficiary validation structure (account %, IFSC %).',
      v_account_count, v_ifsc_count;
  end if;
  v_definition := replace(v_definition, v_account_old, '');
  v_definition := replace(v_definition, v_ifsc_old, '');
  execute v_definition;
end
$patch$;
-- verification-section: workforce-profile-candidate:end

-- verification-section: helper-candidate:start
do $patch$
declare
  v_signature regprocedure :=
    'public.helper_payout_payment_row_candidates(uuid,date,date,jsonb)'::regprocedure;
  v_definition text;
  v_account_old constant text := replace($old$    if public.workforce_payout_bank_account_canonical(v_helper.bank_account_no)
      !~ '^[A-Z0-9]{4,30}$'
    then
      available_to_pay := 0;
      eligibility_code := 'beneficiary_bank_account_invalid';
      eligibility_message := format('Bank account for Helper ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
$old$, chr(13), '');
  v_ifsc_old constant text := replace($old$    if public.workforce_payout_bank_ifsc_canonical(v_helper.ifsc_code)
      !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    then
      available_to_pay := 0;
      eligibility_code := 'beneficiary_ifsc_invalid';
      eligibility_message := format('IFSC for Helper ID %s is invalid.', dropx_id);
      return next;
      continue;
    end if;
$old$, chr(13), '');
  v_account_count integer;
  v_ifsc_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;
  v_account_count := (length(v_definition) - length(replace(v_definition, v_account_old, '')))
    / length(v_account_old);
  v_ifsc_count := (length(v_definition) - length(replace(v_definition, v_ifsc_old, '')))
    / length(v_ifsc_old);
  if v_account_count <> 1 or v_ifsc_count <> 1 then
    raise exception
      'Unexpected Helper beneficiary validation structure (account %, IFSC %).',
      v_account_count, v_ifsc_count;
  end if;
  v_definition := replace(v_definition, v_account_old, '');
  v_definition := replace(v_definition, v_ifsc_old, '');
  execute v_definition;
end
$patch$;
-- verification-section: helper-candidate:end

-- verification-section: workforce-snapshot-constraint:start
alter table public.workforce_payout_payment_items
  drop constraint if exists workforce_payout_payment_items_snapshot_check;
alter table public.workforce_payout_payment_items
  add constraint workforce_payout_payment_items_snapshot_check check (
    nullif(btrim(dropx_id_snapshot), '') is not null
    and nullif(btrim(beneficiary_name_snapshot), '') is not null
    and bank_account_no_snapshot = public.workforce_payout_bank_account_canonical(bank_account_no_snapshot)
    and nullif(btrim(bank_account_no_snapshot), '') is not null
    and ifsc_snapshot = public.workforce_payout_bank_ifsc_canonical(ifsc_snapshot)
    and nullif(btrim(ifsc_snapshot), '') is not null
    and nullif(btrim(location_code_snapshot), '') is not null
    and debit_remarks_snapshot = 'NET PAY'
    and credit_remarks_snapshot = location_code_snapshot
  ) not valid;
alter table public.workforce_payout_payment_items
  validate constraint workforce_payout_payment_items_snapshot_check;
-- verification-section: workforce-snapshot-constraint:end

-- verification-section: helper-snapshot-constraint:start
alter table public.helper_payout_payment_items
  drop constraint if exists helper_payout_payment_items_snapshot_check;
alter table public.helper_payout_payment_items
  add constraint helper_payout_payment_items_snapshot_check check (
    nullif(btrim(dropx_id_snapshot), '') is not null
    and nullif(public.helper_payout_bank_text(beneficiary_name_snapshot), '') is not null
    and bank_account_no_snapshot = public.workforce_payout_bank_account_canonical(bank_account_no_snapshot)
    and nullif(btrim(bank_account_no_snapshot), '') is not null
    and ifsc_snapshot = public.workforce_payout_bank_ifsc_canonical(ifsc_snapshot)
    and nullif(btrim(ifsc_snapshot), '') is not null
    and nullif(public.helper_payout_bank_text(location_code_snapshot), '') is not null
    and target_snapshot_hash ~ '^[0-9a-f]{64}$'
    and debit_remarks_snapshot = 'NET PAY'
    and credit_remarks_snapshot = location_code_snapshot
  ) not valid;
alter table public.helper_payout_payment_items
  validate constraint helper_payout_payment_items_snapshot_check;
-- verification-section: helper-snapshot-constraint:end

-- verification-section: workforce-finalizer:start
do $patch$
declare
  v_signature regprocedure :=
    'public.workforce_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$    if v_account !~ '^[A-Z0-9]{4,30}$'
      or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise <> round(v_item.instruction_amount * 100, 0)
$old$, chr(13), '');
  v_new constant text := replace($new$    if v_account = ''
      or v_ifsc = ''
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise <> round(v_item.instruction_amount * 100, 0)
$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, '')))
    / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception
      'Unexpected Workforce bank-response beneficiary validation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;
-- verification-section: workforce-finalizer:end

-- verification-section: helper-finalizer:start
do $patch$
declare
  v_signature regprocedure :=
    'public.helper_finalize_payout_payment_response(uuid,uuid,uuid,text,text,jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := replace($old$    if v_amount_paise_text !~ '^[1-9][0-9]*$'
      or v_account !~ '^[A-Z0-9]{4,30}$' or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise_text::numeric <> round(v_item.instruction_amount * 100, 0)
$old$, chr(13), '');
  v_new constant text := replace($new$    if v_amount_paise_text !~ '^[1-9][0-9]*$'
      or v_account = '' or v_ifsc = ''
      or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)
      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)
      or v_amount_paise_text::numeric <> round(v_item.instruction_amount * 100, 0)
$new$, chr(13), '');
  v_old_count integer;
  v_new_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '') into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, '')))
    / length(v_new);
  if v_old_count = 1 and v_new_count = 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  elsif v_old_count = 0 and v_new_count = 1 then
    null;
  else
    raise exception
      'Unexpected Helper bank-response beneficiary validation structure (old %, new %).',
      v_old_count, v_new_count;
  end if;
end
$patch$;
-- verification-section: helper-finalizer:end

comment on constraint workforce_payout_payment_items_snapshot_check
  on public.workforce_payout_payment_items is
  'Immutable nonblank beneficiary and payout-location snapshot. Beneficiary account and IFSC syntax is delegated to the bank.';
comment on constraint helper_payout_payment_items_snapshot_check
  on public.helper_payout_payment_items is
  'Immutable nonblank beneficiary and payout-location snapshot. Beneficiary account and IFSC syntax is delegated to the bank.';

notify pgrst, 'reload schema';

commit;
