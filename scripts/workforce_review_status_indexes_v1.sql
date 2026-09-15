begin;

-- payment-notification-counts.ts's loadPeopleReviewCount() and people-exception-count.ts's
-- loadPeopleExceptionCount() both filter contractors/vendors/workers/workforce by exactly
-- (company_id, onboarding_status) on every call -- and this endpoint (/api/payment-notifications)
-- is polled every 15 seconds from every open dashboard tab (PaymentNotificationProvider,
-- mounted globally in app-shell.tsx), so this is one of the hottest query shapes in the app.
--
-- contractors, vendors and workers were all created as `like public.field_executives
-- including all` (scripts/workforce_category_tables_v1.sql) -- that clause copies columns,
-- constraints and defaults, but NOT indexes defined separately after the LIKE table's own
-- creation, so none of the three inherited field_executives_location_id_idx, and none of the
-- four tables in this family (field_executives included) ever had a composite index covering
-- this filter shape at all. Same root cause already documented and fixed for
-- biometric_raw_event_duplicates_archive in query_performance_hotspots_v1.sql.
create index if not exists field_executives_company_onboarding_idx
  on public.field_executives (company_id, onboarding_status);
create index if not exists contractors_company_onboarding_idx
  on public.contractors (company_id, onboarding_status);
create index if not exists vendors_company_onboarding_idx
  on public.vendors (company_id, onboarding_status);
create index if not exists workers_company_onboarding_idx
  on public.workers (company_id, onboarding_status);

-- workforce is a separate, differently-shaped table (not part of the field_executives LIKE
-- family) but is queried by the exact same (company_id, onboarding_status) filter in both
-- functions above, with no supporting index either.
create index if not exists workforce_company_onboarding_idx
  on public.workforce (company_id, onboarding_status);

-- employees uses profile_completion_status, not onboarding_status, and already has
-- employees_company_profile_completion_status_idx (employees_profile_completion_v1.sql) --
-- nothing to add there.

commit;
