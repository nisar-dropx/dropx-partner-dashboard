-- Review thresholds are distinct from attendance qualification. No automatic deduction.
alter table public.workforce_attendance_capture_settings
  add column if not exists review_below_deliveries integer
  check (review_below_deliveries is null or review_below_deliveries between 1 and 100000);
comment on column public.workforce_attendance_capture_settings.review_below_deliveries is
  'Flag worked days below this delivery count for review; does not reduce attendance or pay.';

create or replace function public.save_workforce_attendance_capture_setting_v2(
  p_company_id uuid, p_capture_method text, p_minimum_daily_deliveries integer,
  p_review_below_deliveries integer, p_effective_from date, p_change_reason text, p_actor_user_id uuid
) returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_id bigint;
begin
  if p_review_below_deliveries is not null and (p_review_below_deliveries < 1 or p_review_below_deliveries > 100000) then
    raise exception 'Review delivery threshold must be from 1 to 100000, or blank.';
  end if;
  -- Canonical writer retains the company lock, finalized-period protection,
  -- effective-date preservation and attribution for changes that affect payroll.
  v_id := public.save_workforce_attendance_capture_setting(
    p_company_id, p_capture_method, p_minimum_daily_deliveries,
    p_effective_from, p_change_reason, p_actor_user_id);
  update public.workforce_attendance_capture_settings
    set review_below_deliveries = p_review_below_deliveries
    where id = v_id and company_id = p_company_id;
  return v_id;
end; $$;
revoke all on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) from public, anon, authenticated;
grant execute on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) to service_role;
notify pgrst, 'reload schema';
