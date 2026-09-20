-- Nullable, append-only evidence on the existing service-role-only audit.
-- No fabricated membership is attached to historical aggregate-only records.
alter table public.ops_review_edd_observations
  add column if not exists package_details jsonb;
comment on column public.ops_review_edd_observations.package_details is
  'Immutable compact package evidence captured with counts. Null means historical TID membership was not recorded. Not selected by timeline or summary reports.';
