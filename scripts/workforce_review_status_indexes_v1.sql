begin;

-- payment-notification-counts.ts's loadPeopleReviewCount() and people-exception-count.ts's
-- loadPeopleExceptionCount() both filter contractors/vendors/helpers/workforce by exactly
-- (company_id, onboarding_status) on every call -- and this endpoint (/api/payment-notifications)
-- is polled every 15 seconds from every open dashboard tab (PaymentNotificationProvider,
-- mounted globally in app-shell.tsx), so this is one of the hottest query shapes in the app.
--
-- Table-naming note, to avoid re-tripping over this: the "worker" profile type's real table is
-- "helpers" -- not "workers" -- per src/lib/workforce-profiles.ts's nonEmployeeProfileConfigs
-- (route "/workers", pageCode "workers", but table: "helpers"). Confirmed against multiple live
-- .from("helpers") call sites (people-export, pan-aadhaar-export, notifications/whatsapp,
-- biometric/attendance.ts) and by this migration itself failing with "relation public.workers
-- does not exist" on its first corrected attempt. Do not rename this to "workers" again.
--
-- field_executives (this whole family's original LIKE-clause source table, per the older
-- scripts/workforce_category_tables_v1.sql) also no longer exists in production -- likely
-- renamed/consolidated into "workforce" at some point not captured as its own tracked script --
-- so it's excluded here too; the workforce index below already covers that concept. That
-- original LIKE clause copied columns/constraints/defaults but NOT indexes defined separately
-- afterward, so none of contractors/vendors/helpers ever inherited a composite index covering
-- this filter shape. Same root cause already documented and fixed for
-- biometric_raw_event_duplicates_archive in query_performance_hotspots_v1.sql.
create index if not exists contractors_company_onboarding_idx
  on public.contractors (company_id, onboarding_status);
create index if not exists vendors_company_onboarding_idx
  on public.vendors (company_id, onboarding_status);
create index if not exists helpers_company_onboarding_idx
  on public.helpers (company_id, onboarding_status);

-- workforce is queried by the exact same (company_id, onboarding_status) filter in both
-- functions above, with no supporting index either.
create index if not exists workforce_company_onboarding_idx
  on public.workforce (company_id, onboarding_status);

-- employees uses profile_completion_status, not onboarding_status, and already has
-- employees_company_profile_completion_status_idx (employees_profile_completion_v1.sql) --
-- nothing to add there.

commit;
