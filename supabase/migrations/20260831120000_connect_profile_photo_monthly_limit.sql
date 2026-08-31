alter table public.connect_identity_verification_policies
  add column if not exists profile_photo_monthly_updates_limit smallint not null default 2;

alter table public.connect_identity_verification_policies
  drop constraint if exists connect_identity_verification_policies_monthly_limit_check;

alter table public.connect_identity_verification_policies
  add constraint connect_identity_verification_policies_monthly_limit_check
  check (profile_photo_monthly_updates_limit between 0 and 31);

comment on column public.connect_identity_verification_policies.profile_photo_monthly_updates_limit is
  'Maximum verified profile photo updates per worker per calendar month (Asia/Kolkata). 0 disables self-service updates.';

notify pgrst, 'reload schema';
