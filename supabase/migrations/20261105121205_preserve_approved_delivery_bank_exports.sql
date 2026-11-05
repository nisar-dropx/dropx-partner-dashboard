begin;

-- A payment accepted before delivery identity was enabled must still be able to
-- enter bank processing. The earlier compatibility trigger covered only rows
-- already processing, so a single legacy approved van payment blocked the whole
-- bank-file download. New inserts and amount/identity/bank edits still validate.
-- This changes only trigger eligibility; approvals, bank checks, audit history
-- and the confirmed-identity / duplicate-payout guard remain unchanged.
drop trigger if exists payment_delivery_identity_guard_update on public.payment_requests;

create trigger payment_delivery_identity_guard_update
before update on public.payment_requests
for each row
when (
  not (
    old.delivery_identity_confirmed is false
    and new.delivery_identity_confirmed is false
    and old.amount is not null
    and old.adhoc_payout_effect = 'none'
    and coalesce(lower(old.status), '') in ('approved', 'owner_approved', 'processing', 'processed', 'paid')
    and coalesce(lower(new.status), '') in ('approved', 'owner_approved', 'processing', 'processed', 'paid')
    and row(
      new.company_id,
      new.location_id,
      new.payment_head_id,
      new.source_system,
      new.amount,
      new.amount_requested,
      new.amount_approved,
      new.work_date,
      new.payment_mode,
      new.bank_account_no,
      new.beneficiary_account_no,
      new.beneficiary_account_number,
      new.ifsc,
      new.beneficiary_ifsc,
      new.account_holder_name,
      new.beneficiary_account_holder,
      new.delivery_performer_mode,
      new.delivery_work_date,
      new.delivery_shipment_id,
      new.delivery_provider_employee_id,
      new.delivery_performer_workforce_id,
      new.delivery_performer_name,
      new.adhoc_payout_effect,
      new.adhoc_client
    ) is not distinct from row(
      old.company_id,
      old.location_id,
      old.payment_head_id,
      old.source_system,
      old.amount,
      old.amount_requested,
      old.amount_approved,
      old.work_date,
      old.payment_mode,
      old.bank_account_no,
      old.beneficiary_account_no,
      old.beneficiary_account_number,
      old.ifsc,
      old.beneficiary_ifsc,
      old.account_holder_name,
      old.beneficiary_account_holder,
      old.delivery_performer_mode,
      old.delivery_work_date,
      old.delivery_shipment_id,
      old.delivery_provider_employee_id,
      old.delivery_performer_workforce_id,
      old.delivery_performer_name,
      old.adhoc_payout_effect,
      old.adhoc_client
    )
  )
)
execute function public.payment_delivery_identity_guard();

commit;
