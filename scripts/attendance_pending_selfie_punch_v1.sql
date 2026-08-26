-- Pending selfie punch + held attendance until manager approve
-- Run on shared Supabase after attendance_gps_integrity_v1.sql

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'attendance_integrity_flags_type_check'
      and conrelid = 'public.attendance_integrity_flags'::regclass
  ) then
    alter table public.attendance_integrity_flags
      drop constraint attendance_integrity_flags_type_check;
  end if;

  alter table public.attendance_integrity_flags
    add constraint attendance_integrity_flags_type_check check (
      flag_type in (
        'outside_geofence_punch',
        'outside_geofence_gt_2h',
        'biometric_phone_mismatch',
        'integrity_risk',
        'forgot_punch_out',
        'pending_selfie_punch'
      )
    );
end $$;
