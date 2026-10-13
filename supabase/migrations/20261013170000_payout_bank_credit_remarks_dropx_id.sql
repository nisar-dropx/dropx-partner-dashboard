begin;

-- New payout bank instructions identify the beneficiary by DropX ID in
-- FedOne's Credit Remarks column. Historical instructions remain immutable:
-- their stored location-code remark is still accepted and re-downloaded
-- exactly as originally generated.

create or replace function public.set_payout_payment_credit_remarks_dropx()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.credit_remarks_snapshot := upper(btrim(new.dropx_id_snapshot));
  return new;
end
$function$;

-- verification-section: workforce:start
-- Trigger names sort after the existing 00 ledger guards. The guards retain
-- sole control over who may insert, while this trigger owns the exported
-- Credit Remarks snapshot for every current or future creator RPC.
drop trigger if exists workforce_payout_payment_items_10_credit_remarks_dropx
  on public.workforce_payout_payment_items;
create trigger workforce_payout_payment_items_10_credit_remarks_dropx
before insert on public.workforce_payout_payment_items
for each row execute function public.set_payout_payment_credit_remarks_dropx();

-- Permit the original location-code snapshots and the new DropX-ID snapshots.
-- No historical row is rewritten, so re-download remains content-stable.
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
    and credit_remarks_snapshot in (
      location_code_snapshot,
      upper(btrim(dropx_id_snapshot))
    )
  ) not valid;
alter table public.workforce_payout_payment_items
  validate constraint workforce_payout_payment_items_snapshot_check;

comment on column public.workforce_payout_payment_items.credit_remarks_snapshot is
  'Immutable FedOne Credit Remarks value: DropX ID for new instructions; historical instructions retain their original location code.';
-- verification-section: workforce:end

-- verification-section: helper:start
drop trigger if exists helper_payout_payment_items_10_credit_remarks_dropx
  on public.helper_payout_payment_items;
create trigger helper_payout_payment_items_10_credit_remarks_dropx
before insert on public.helper_payout_payment_items
for each row execute function public.set_payout_payment_credit_remarks_dropx();

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
    and credit_remarks_snapshot in (
      location_code_snapshot,
      upper(btrim(dropx_id_snapshot))
    )
  ) not valid;
alter table public.helper_payout_payment_items
  validate constraint helper_payout_payment_items_snapshot_check;

comment on column public.helper_payout_payment_items.credit_remarks_snapshot is
  'Immutable FedOne Credit Remarks value: DropX ID for new instructions; historical instructions retain their original location code.';
-- verification-section: helper:end

comment on function public.set_payout_payment_credit_remarks_dropx() is
  'Sets new Workforce and Helper payout bank Credit Remarks snapshots to the normalized DropX ID.';

revoke all on function public.set_payout_payment_credit_remarks_dropx()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
