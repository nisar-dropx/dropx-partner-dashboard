begin;

-- The delivery-identity policy was activated after some van requests had
-- already entered bank processing without the new identity fields. Preserve
-- those in-flight rows through processing/paid status changes, while keeping
-- the normal guard on every new request and every request that has not yet
-- entered processing.
drop trigger if exists payment_delivery_identity_guard on public.payment_requests;
drop trigger if exists payment_delivery_identity_guard_insert on public.payment_requests;
drop trigger if exists payment_delivery_identity_guard_update on public.payment_requests;
drop trigger if exists payment_delivery_identity_guard_delete on public.payment_requests;

create trigger payment_delivery_identity_guard_insert
before insert on public.payment_requests
for each row execute function public.payment_delivery_identity_guard();

create trigger payment_delivery_identity_guard_update
before update on public.payment_requests
for each row
when (
  not (
    old.delivery_identity_confirmed is false
    and new.delivery_identity_confirmed is false
    and lower(old.status) in ('processing', 'processed', 'paid')
    and lower(new.status) in ('processing', 'processed', 'paid')
    and row(
      new.company_id,
      new.location_id,
      new.payment_head_id,
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

create trigger payment_delivery_identity_guard_delete
before delete on public.payment_requests
for each row execute function public.payment_delivery_identity_guard();

commit;
