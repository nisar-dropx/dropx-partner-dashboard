begin;

-- payment_adhoc_driver_guard (and other invoker-security payment writers) call
-- these helpers while the session role is service_role. The dependency-revision
-- migration revoked EXECUTE from everyone including service_role, which surfaces
-- as 42501 when approving Adhoc Driver requests (absence activate/deactivate).
grant execute on function public.workforce_bump_payout_period_dependency_revision(uuid, date)
  to service_role;
grant execute on function public.enqueue_workforce_payout_dependency_refresh(uuid, uuid, uuid, date, date, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
