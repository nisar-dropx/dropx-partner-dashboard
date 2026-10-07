-- Review thresholds are distinct from attendance qualification. No automatic deduction.
alter table public.workforce_attendance_capture_settings
  add column if not exists review_below_deliveries integer
  check (review_below_deliveries is null or review_below_deliveries between 1 and 100000);
comment on column public.workforce_attendance_capture_settings.review_below_deliveries is
  'Flag worked days below this delivery count for review; does not reduce attendance or pay.';

create or replace function public.save_workforce_attendance_capture_setting_v2(
  p_company_id uuid, p_capture_method text, p_minimum_daily_deliveries integer,
  p_review_below_deliveries integer, p_effective_from date, p_change_reason text, p_actor_user_id uuid
) returns bigint language sql security invoker set search_path = '' as $$
  select public.save_workforce_attendance_capture_setting_internal(
    p_company_id,
    p_capture_method,
    p_minimum_daily_deliveries,
    p_review_below_deliveries,
    true,
    p_effective_from,
    p_change_reason,
    p_actor_user_id
  );
$$;
comment on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) is
  'Atomically saves capture and review thresholds through the canonical attendance-policy writer.';
revoke all on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) from public, anon, authenticated;
grant execute on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) to service_role;
notify pgrst, 'reload schema';
