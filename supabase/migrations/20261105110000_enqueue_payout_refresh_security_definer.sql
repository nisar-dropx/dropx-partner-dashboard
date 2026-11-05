begin;

-- payment_adhoc_driver_guard runs as the session role (service_role) and calls
-- enqueue_workforce_payout_dependency_refresh. That helper inserts into
-- workforce_payout_publication_refresh_jobs, which intentionally has no INSERT
-- grant for service_role (service-only queue, inserts via definer writers).
-- The enqueue helper was left SECURITY INVOKER, so Adhoc Driver approve hit 42501.
alter function public.enqueue_workforce_payout_dependency_refresh(uuid, uuid, uuid, date, date, uuid)
  security definer;

-- Match payment_delivery_identity_guard so Adhoc absence activation does not
-- depend on every nested table/function grant for service_role.
alter function public.payment_adhoc_driver_guard()
  security definer;

grant execute on function public.enqueue_workforce_payout_dependency_refresh(uuid, uuid, uuid, date, date, uuid)
  to service_role;
grant execute on function public.payment_adhoc_driver_guard()
  to service_role;

notify pgrst, 'reload schema';

commit;
