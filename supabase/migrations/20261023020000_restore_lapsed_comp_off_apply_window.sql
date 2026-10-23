-- Restore lapsed compensatory off + customisable apply-earliest window.
--
-- 1. Leave-type settings control how early a credit may be used in its earning month
--    (day after worked / month start / N days before the worked day, clamped to month start).
-- 2. Ledger credits can carry usable_from / apply_until overrides (set when HR restores a
--    lapse whose natural window has already closed).
-- 3. hr_restore_lapsed_comp_off reverses one unrestored lapse debit and optionally extends
--    the matched earn credit's window so DropX One can open the date picker again.
-- 4. Lapse cron respects credit.apply_until when set, so a restored extension is not
--    immediately re-lapsed on the natural mid-month/holiday date.

alter table public.hr_leave_types
  add column if not exists comp_off_apply_earliest_mode text not null default 'day_after',
  add column if not exists comp_off_apply_days_before integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hr_leave_types_comp_off_apply_earliest_mode_check'
  ) then
    alter table public.hr_leave_types
      add constraint hr_leave_types_comp_off_apply_earliest_mode_check
      check (comp_off_apply_earliest_mode in ('day_after', 'month_start', 'days_before'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'hr_leave_types_comp_off_apply_days_before_check'
  ) then
    alter table public.hr_leave_types
      add constraint hr_leave_types_comp_off_apply_days_before_check
      check (
        comp_off_apply_days_before is null
        or (comp_off_apply_days_before >= 0 and comp_off_apply_days_before <= 31)
      );
  end if;
end $$;

comment on column public.hr_leave_types.comp_off_apply_earliest_mode is
  'When an earned comp-off credit may first be used: day_after (default), month_start, or days_before the worked day (same month only).';
comment on column public.hr_leave_types.comp_off_apply_days_before is
  'Used when comp_off_apply_earliest_mode = days_before. 0 = usable on the worked day itself. Clamped to the earning month start.';

alter table public.hr_leave_balance_ledger
  add column if not exists usable_from date,
  add column if not exists apply_until date;

comment on column public.hr_leave_balance_ledger.usable_from is
  'Optional override: earliest leave date this credit may cover. Null = derive from leave-type apply-earliest mode.';
comment on column public.hr_leave_balance_ledger.apply_until is
  'Optional override: last calendar day a request using this credit may be submitted. Null = derive from lapse rules. Lapse cron uses this when set.';

create or replace function public.hr_restore_lapsed_comp_off(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_lapse_id uuid,
  p_earned_reference_date date,
  p_note text,
  p_apply_until date default null,
  p_usable_from date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lapse public.hr_leave_balance_ledger%rowtype;
  v_credit public.hr_leave_balance_ledger%rowtype;
  v_restore_id uuid;
  v_note text := btrim(coalesce(p_note, ''));
  v_today date := (timezone('Asia/Kolkata', now()))::date;
begin
  if length(v_note) < 3 then
    raise exception 'Enter a reason for restoring this lapsed comp-off.';
  end if;
  if p_earned_reference_date is null then
    raise exception 'Select the earned date of the credit being restored.';
  end if;

  select * into v_lapse
  from public.hr_leave_balance_ledger
  where company_id = p_company_id and id = p_lapse_id
  for update;
  if not found then
    raise exception 'Lapse entry not found.';
  end if;
  if v_lapse.source not in ('comp_off_lapsed', 'comp_off_holiday_lapsed') then
    raise exception 'Only a lapsed comp-off debit can be restored.';
  end if;
  if v_lapse.days >= 0 then
    raise exception 'Lapse entry must be a debit.';
  end if;
  if exists (
    select 1 from public.hr_leave_balance_ledger r
    where r.company_id = p_company_id
      and r.source = 'hr_manual_adjustment'
      and r.reference_id = v_lapse.id
  ) then
    raise exception 'This lapse has already been restored.';
  end if;

  select * into v_credit
  from public.hr_leave_balance_ledger
  where company_id = p_company_id
    and worker_type = v_lapse.worker_type
    and worker_id = v_lapse.worker_id
    and leave_type_id = v_lapse.leave_type_id
    and entry_type = 'credit'
    and reference_date = p_earned_reference_date
    and source in ('comp_off_earned', 'comp_off_earned_week_off')
  order by created_at asc
  limit 1
  for update;
  if not found then
    raise exception 'No earned credit found for % on that leave type.', p_earned_reference_date;
  end if;

  if p_usable_from is not null then
    if p_usable_from > p_earned_reference_date then
      raise exception 'Usable-from cannot be after the earned date.';
    end if;
    if date_trunc('month', p_usable_from)::date <> date_trunc('month', p_earned_reference_date)::date then
      raise exception 'Usable-from must stay in the same month as the earned date.';
    end if;
  end if;

  if p_apply_until is not null then
    if p_apply_until < v_today then
      raise exception 'Apply-until must be today or a future date.';
    end if;
    if p_apply_until < p_earned_reference_date then
      raise exception 'Apply-until cannot be before the earned date.';
    end if;
  end if;

  insert into public.hr_leave_balance_ledger(
    company_id, worker_type, worker_id, leave_type_id, leave_year, entry_type,
    days, source, reference_id, reference_date, note, created_by,
    usable_from, apply_until
  ) values (
    v_lapse.company_id, v_lapse.worker_type, v_lapse.worker_id, v_lapse.leave_type_id, 0, 'adjustment',
    -v_lapse.days, 'hr_manual_adjustment', v_lapse.id, p_earned_reference_date, v_note, p_actor_user_id,
    null, null
  ) returning id into v_restore_id;

  -- Extend / reopen the original credit's window when HR sets overrides. Natural
  -- mid-month holiday windows that are still open need no update.
  if p_apply_until is not null or p_usable_from is not null then
    update public.hr_leave_balance_ledger
    set apply_until = coalesce(p_apply_until, apply_until),
        usable_from = coalesce(p_usable_from, usable_from)
    where id = v_credit.id;
  end if;

  return v_restore_id;
end;
$$;

revoke all on function public.hr_restore_lapsed_comp_off(uuid, uuid, uuid, date, text, date, date) from public, anon, authenticated;
grant execute on function public.hr_restore_lapsed_comp_off(uuid, uuid, uuid, date, text, date, date) to service_role;

create or replace function public.hr_lapse_comp_off_by_source(
  p_as_of date,
  p_earn_source text,
  p_lapse_days_column text,
  p_lapsed_source text
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_leave_type record;
  v_credit record;
  v_lapse_date date;
  v_current_balance numeric;
  v_lapse_amount numeric;
  v_lapsed integer := 0;
begin
  for v_leave_type in
    select id, company_id, comp_off_week_off_lapse_days, comp_off_holiday_lapse_days
    from public.hr_leave_types
    where balance_mode = 'earned_balance' and is_active
  loop
    for v_credit in
      select worker_type, worker_id, days, reference_date, apply_until
      from public.hr_leave_balance_ledger ledger
      where ledger.company_id = v_leave_type.company_id
        and ledger.leave_type_id = v_leave_type.id
        and ledger.source = p_earn_source
        and ledger.reference_date is not null
        and not exists (
          select 1 from public.hr_leave_balance_ledger already
          where already.company_id = ledger.company_id
            and already.worker_type = ledger.worker_type and already.worker_id = ledger.worker_id
            and already.leave_type_id = ledger.leave_type_id and already.source = p_lapsed_source
            and already.reference_date = p_as_of
        )
    loop
      -- Restored credits can carry an apply_until override; lapse the day after that.
      if v_credit.apply_until is not null then
        v_lapse_date := v_credit.apply_until + 1;
      elsif p_earn_source = 'comp_off_earned' and v_credit.reference_date > date_trunc('month', v_credit.reference_date)::date + 24 then
        v_lapse_date := v_credit.reference_date + 14;
      elsif p_earn_source = 'comp_off_earned' then
        v_lapse_date := (date_trunc('month', v_credit.reference_date) + interval '1 month')::date + 1;
      elsif v_leave_type.comp_off_week_off_lapse_days is not null then
        v_lapse_date := v_credit.reference_date + v_leave_type.comp_off_week_off_lapse_days;
      else
        continue;
      end if;
      continue when v_lapse_date <> p_as_of;

      select coalesce(remaining, 0) into v_current_balance
      from public.hr_resolve_leave_balance(v_leave_type.company_id, v_credit.worker_type, v_credit.worker_id, v_leave_type.id, null, p_as_of);
      v_lapse_amount := least(v_credit.days, greatest(v_current_balance, 0));
      if v_lapse_amount > 0 then
        insert into public.hr_leave_balance_ledger(company_id, worker_type, worker_id, leave_type_id, leave_year, entry_type, days, source, reference_date)
        values (v_leave_type.company_id, v_credit.worker_type, v_credit.worker_id, v_leave_type.id, 0, 'debit', -v_lapse_amount, p_lapsed_source, p_as_of)
        on conflict (company_id, worker_type, worker_id, leave_type_id, reference_date) where source = p_lapsed_source do nothing;
        if found then v_lapsed := v_lapsed + 1; end if;
      end if;
    end loop;
  end loop;
  return v_lapsed;
end;
$$;

revoke all on function public.hr_lapse_comp_off_by_source(date, text, text, text) from public, anon, authenticated;
grant execute on function public.hr_lapse_comp_off_by_source(date, text, text, text) to service_role;
