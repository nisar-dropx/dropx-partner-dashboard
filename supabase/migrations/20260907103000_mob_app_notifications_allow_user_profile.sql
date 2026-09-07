-- Allow People-workspace manager logins (profile_type = user) to receive app notifications.
-- Without this, reimbursement approval alerts only landed on the linked employee account.

begin;

alter table public.mob_app_notifications
  drop constraint if exists mob_app_notifications_profile_type_check;

alter table public.mob_app_notifications
  add constraint mob_app_notifications_profile_type_check
  check (recipient_profile_type in ('user', 'employee', 'field_executive', 'contractor', 'vendor', 'worker', 'workforce'));

commit;
