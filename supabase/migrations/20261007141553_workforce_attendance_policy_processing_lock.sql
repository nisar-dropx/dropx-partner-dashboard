begin;

set local lock_timeout = '15s';
set local statement_timeout = '60s';

create or replace function public.workforce_attendance_capture_interval_is_locked(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('review', 'approved', 'paid')
      and payroll_run.period_end >= p_effective_from
      and (p_effective_until is null or payroll_run.period_start < p_effective_until)

    union all

    select 1
    from public.workforce_payout_review_submissions review_submission
    where review_submission.company_id = p_company_id
      and review_submission.subject_type = 'workforce'
      and lower(coalesce(review_submission.status, '')) in ('under_review', 'approved')
      and review_submission.period_end >= p_effective_from
      and (p_effective_until is null or review_submission.period_start < p_effective_until)
  );
$function$;

create or replace function public.assert_workforce_attendance_capture_interval_open(
  p_company_id uuid,
  p_effective_from date,
  p_effective_until date
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if public.workforce_attendance_capture_interval_is_locked(
    p_company_id,
    p_effective_from,
    p_effective_until
  ) then
    raise exception 'Attendance capture cannot change because Workforce payouts for this period are already under review or processed.';
  end if;
end;
$function$;

create or replace function public.guard_finalized_workforce_attendance_capture_setting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_until date;
  v_new_until date;
begin
  if tg_op = 'INSERT' then
    perform public.lock_workforce_payment_allocation_company(new.company_id);

    select min(setting.effective_from)
    into v_new_until
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = new.company_id
      and setting.effective_from > new.effective_from;

    if public.workforce_attendance_capture_interval_is_locked(
      new.company_id,
      new.effective_from,
      v_new_until
    ) and not exists (
      select 1
      from public.workforce_attendance_capture_settings active_setting
      where active_setting.id = (
        select candidate.id
        from public.workforce_attendance_capture_settings candidate
        where candidate.company_id = new.company_id
          and candidate.effective_from <= new.effective_from
        order by candidate.effective_from desc
        limit 1
      )
        and active_setting.capture_method = new.capture_method
        and active_setting.minimum_daily_deliveries is not distinct from new.minimum_daily_deliveries
        and (pg_catalog.to_jsonb(active_setting) -> 'review_below_deliveries')
          is not distinct from (pg_catalog.to_jsonb(new) -> 'review_below_deliveries')
    ) then
      raise exception 'Attendance capture cannot change because Workforce payouts for this period are already under review or processed.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.lock_workforce_payment_allocation_company(old.company_id);

    select min(setting.effective_from)
    into v_old_until
    from public.workforce_attendance_capture_settings setting
    where setting.company_id = old.company_id
      and setting.id <> old.id
      and setting.effective_from > old.effective_from;

    perform public.assert_workforce_attendance_capture_interval_open(
      old.company_id,
      old.effective_from,
      v_old_until
    );
    return old;
  end if;

  if old.company_id::text <= new.company_id::text then
    perform public.lock_workforce_payment_allocation_company(old.company_id);
    if new.company_id is distinct from old.company_id then
      perform public.lock_workforce_payment_allocation_company(new.company_id);
    end if;
  else
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    perform public.lock_workforce_payment_allocation_company(old.company_id);
  end if;

  select min(setting.effective_from)
  into v_old_until
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = old.company_id
    and setting.id <> old.id
    and setting.effective_from > old.effective_from;

  select min(setting.effective_from)
  into v_new_until
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = new.company_id
    and setting.id <> old.id
    and setting.effective_from > new.effective_from;

  perform public.assert_workforce_attendance_capture_interval_open(
    old.company_id,
    old.effective_from,
    v_old_until
  );
  perform public.assert_workforce_attendance_capture_interval_open(
    new.company_id,
    new.effective_from,
    v_new_until
  );
  return new;
end;
$function$;

create or replace function public.save_workforce_attendance_capture_setting_internal(
  p_company_id uuid,
  p_capture_method text,
  p_minimum_daily_deliveries integer,
  p_review_below_deliveries integer,
  p_manage_review_threshold boolean,
  p_effective_from date,
  p_change_reason text,
  p_actor_user_id uuid
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_next_effective_from date;
  v_preserve_from date;
  v_old_capture_method text;
  v_old_minimum_daily_deliveries integer;
  v_old_review_below_deliveries integer;
  v_target_review_below_deliveries integer;
  v_has_review_threshold boolean;
  v_old_setting_found boolean;
  v_saved_id bigint;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'Company and acting user are required.';
  end if;
  if p_effective_from is null
    or p_effective_from <> date_trunc('month', p_effective_from)::date then
    raise exception 'Choose a valid effective month.';
  end if;
  if p_capture_method not in ('biometric', 'shipment_data') then
    raise exception 'Choose biometric or shipment data for attendance capture.';
  end if;
  if p_capture_method = 'biometric' and p_minimum_daily_deliveries is not null then
    raise exception 'A shipment threshold applies only to shipment-data attendance.';
  end if;
  if p_capture_method = 'shipment_data'
    and (p_minimum_daily_deliveries is null or p_minimum_daily_deliveries <= 0) then
    raise exception 'Shipment-data attendance requires a positive daily delivery threshold.';
  end if;
  if p_manage_review_threshold
    and p_review_below_deliveries is not null
    and p_review_below_deliveries not between 1 and 100000 then
    raise exception 'Review delivery threshold must be from 1 to 100000, or blank.';
  end if;
  if char_length(btrim(coalesce(p_change_reason, ''))) not between 3 and 250 then
    raise exception 'Change reason must be from 3 to 250 characters.';
  end if;

  perform public.lock_workforce_payment_allocation_company(p_company_id);

  perform public.assert_workforce_attendance_capture_interval_open(
    p_company_id,
    p_effective_from,
    (p_effective_from + interval '1 month')::date
  );

  select exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.workforce_attendance_capture_settings'::pg_catalog.regclass
      and attribute.attname = 'review_below_deliveries'
      and not attribute.attisdropped
  ) into v_has_review_threshold;

  select
    setting.capture_method,
    setting.minimum_daily_deliveries
  into
    v_old_capture_method,
    v_old_minimum_daily_deliveries
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from <= p_effective_from
  order by setting.effective_from desc
  limit 1;
  v_old_setting_found := found;

  if v_old_setting_found and v_has_review_threshold then
    execute $sql$
      select setting.review_below_deliveries
      from public.workforce_attendance_capture_settings setting
      where setting.company_id = $1
        and setting.effective_from <= $2
      order by setting.effective_from desc
      limit 1
    $sql$
    into v_old_review_below_deliveries
    using p_company_id, p_effective_from;
  end if;

  if not v_old_setting_found then
    v_old_capture_method := 'biometric';
    v_old_minimum_daily_deliveries := null;
    v_old_review_below_deliveries := null;
  end if;

  v_target_review_below_deliveries := case
    when p_manage_review_threshold then p_review_below_deliveries
    else v_old_review_below_deliveries
  end;

  select min(setting.effective_from)
  into v_next_effective_from
  from public.workforce_attendance_capture_settings setting
  where setting.company_id = p_company_id
    and setting.effective_from > p_effective_from;

  select min(locked_period.effective_month)
  into v_preserve_from
  from (
    select date_trunc('month', payroll_run.period_start)::date as effective_month
    from public.workforce_payroll_runs payroll_run
    where payroll_run.company_id = p_company_id
      and lower(coalesce(payroll_run.status, '')) in ('review', 'approved', 'paid')
      and payroll_run.period_end >= (p_effective_from + interval '1 month')::date

    union all

    select date_trunc('month', review_submission.period_start)::date as effective_month
    from public.workforce_payout_review_submissions review_submission
    where review_submission.company_id = p_company_id
      and review_submission.subject_type = 'workforce'
      and lower(coalesce(review_submission.status, '')) in ('under_review', 'approved')
      and review_submission.period_end >= (p_effective_from + interval '1 month')::date
  ) locked_period
  where locked_period.effective_month > p_effective_from
    and (v_next_effective_from is null or locked_period.effective_month < v_next_effective_from);

  if v_preserve_from is not null then
    if v_has_review_threshold then
      execute $sql$
        insert into public.workforce_attendance_capture_settings (
          company_id,
          capture_method,
          minimum_daily_deliveries,
          review_below_deliveries,
          effective_from,
          change_reason,
          created_by,
          updated_by
        ) values ($1, $2, $3, $4, $5, $6, $7, $7)
        on conflict (company_id, effective_from) do nothing
      $sql$
      using
        p_company_id,
        v_old_capture_method,
        v_old_minimum_daily_deliveries,
        v_old_review_below_deliveries,
        v_preserve_from,
        'System preserved attendance capture used by a payout under review or already processed.',
        p_actor_user_id;
    else
      insert into public.workforce_attendance_capture_settings (
        company_id,
        capture_method,
        minimum_daily_deliveries,
        effective_from,
        change_reason,
        created_by,
        updated_by
      ) values (
        p_company_id,
        v_old_capture_method,
        v_old_minimum_daily_deliveries,
        v_preserve_from,
        'System preserved attendance capture used by a payout under review or already processed.',
        p_actor_user_id,
        p_actor_user_id
      ) on conflict (company_id, effective_from) do nothing;
    end if;
  end if;

  if v_has_review_threshold then
    execute $sql$
      insert into public.workforce_attendance_capture_settings (
        company_id,
        capture_method,
        minimum_daily_deliveries,
        review_below_deliveries,
        effective_from,
        change_reason,
        created_by,
        updated_by
      ) values ($1, $2, $3, $4, $5, $6, $7, $7)
      on conflict (company_id, effective_from) do update set
        capture_method = excluded.capture_method,
        minimum_daily_deliveries = excluded.minimum_daily_deliveries,
        review_below_deliveries = excluded.review_below_deliveries,
        change_reason = excluded.change_reason,
        updated_by = excluded.updated_by
      returning id
    $sql$
    into v_saved_id
    using
      p_company_id,
      p_capture_method,
      p_minimum_daily_deliveries,
      v_target_review_below_deliveries,
      p_effective_from,
      btrim(p_change_reason),
      p_actor_user_id;
  else
    insert into public.workforce_attendance_capture_settings (
      company_id,
      capture_method,
      minimum_daily_deliveries,
      effective_from,
      change_reason,
      created_by,
      updated_by
    ) values (
      p_company_id,
      p_capture_method,
      p_minimum_daily_deliveries,
      p_effective_from,
      btrim(p_change_reason),
      p_actor_user_id,
      p_actor_user_id
    ) on conflict (company_id, effective_from) do update set
      capture_method = excluded.capture_method,
      minimum_daily_deliveries = excluded.minimum_daily_deliveries,
      change_reason = excluded.change_reason,
      updated_by = excluded.updated_by
    returning id into v_saved_id;
  end if;

  return v_saved_id;
end;
$function$;

create or replace function public.save_workforce_attendance_capture_setting(
  p_company_id uuid,
  p_capture_method text,
  p_minimum_daily_deliveries integer,
  p_effective_from date,
  p_change_reason text,
  p_actor_user_id uuid
)
returns bigint
language sql
security invoker
set search_path = ''
as $function$
  select public.save_workforce_attendance_capture_setting_internal(
    p_company_id,
    p_capture_method,
    p_minimum_daily_deliveries,
    null,
    false,
    p_effective_from,
    p_change_reason,
    p_actor_user_id
  );
$function$;

create or replace function public.lock_workforce_attendance_policy_review_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.lock_workforce_payment_allocation_company(old.company_id);
    return old;
  end if;

  if old.company_id::text <= new.company_id::text then
    perform public.lock_workforce_payment_allocation_company(old.company_id);
    if new.company_id is distinct from old.company_id then
      perform public.lock_workforce_payment_allocation_company(new.company_id);
    end if;
  else
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    perform public.lock_workforce_payment_allocation_company(old.company_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists workforce_payout_review_submissions_00_attendance_policy_lock
  on public.workforce_payout_review_submissions;
create trigger workforce_payout_review_submissions_00_attendance_policy_lock
before insert or update or delete on public.workforce_payout_review_submissions
for each row execute function public.lock_workforce_attendance_policy_review_submission();

create or replace function public.prevent_workforce_attendance_capture_history_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Workforce attendance-capture history is immutable.';
end;
$function$;

drop trigger if exists workforce_attendance_capture_history_immutable
  on public.workforce_attendance_capture_setting_history;
create trigger workforce_attendance_capture_history_immutable
before update or delete on public.workforce_attendance_capture_setting_history
for each row execute function public.prevent_workforce_attendance_capture_history_mutation();

-- This migration sorts before the migration that adds review_below_deliveries
-- in a fresh database, but production may already have that later migration.
-- Install the atomic v2 wrapper now only when the column is present; the later
-- migration installs the same wrapper during a fresh replay.
do $do$
begin
  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.workforce_attendance_capture_settings'::pg_catalog.regclass
      and attribute.attname = 'review_below_deliveries'
      and not attribute.attisdropped
  ) then
    execute $definition$
      create or replace function public.save_workforce_attendance_capture_setting_v2(
        p_company_id uuid,
        p_capture_method text,
        p_minimum_daily_deliveries integer,
        p_review_below_deliveries integer,
        p_effective_from date,
        p_change_reason text,
        p_actor_user_id uuid
      )
      returns bigint
      language sql
      security invoker
      set search_path = ''
      as $wrapper$
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
      $wrapper$
    $definition$;
    execute 'revoke all on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) from public, anon, authenticated';
    execute 'grant execute on function public.save_workforce_attendance_capture_setting_v2(uuid,text,integer,integer,date,text,uuid) to service_role';
  end if;
end
$do$;

comment on function public.workforce_attendance_capture_interval_is_locked(uuid, date, date) is
  'Returns whether a Workforce attendance-policy interval overlaps payroll in review/approved/paid or a Workforce payout submission under review/approved.';
comment on function public.assert_workforce_attendance_capture_interval_open(uuid, date, date) is
  'Rejects Workforce attendance-policy changes once any payout in the effective interval is under review or processed.';
comment on function public.guard_finalized_workforce_attendance_capture_setting() is
  'Serializes attendance-policy writes and protects intervals used by Workforce payouts under review or already processed.';
comment on function public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid) is
  'Atomically saves one open attendance-policy month and preserves the prior policy at the first later payout period that is under review or processed.';
comment on function public.save_workforce_attendance_capture_setting_internal(uuid, text, integer, integer, boolean, date, text, uuid) is
  'Canonical attendance-policy writer shared by legacy and review-threshold RPCs; keeps preservation boundaries and audit rows atomic.';
comment on function public.lock_workforce_attendance_policy_review_submission() is
  'Serializes payout-review state changes with attendance-policy changes for the same company.';
comment on function public.prevent_workforce_attendance_capture_history_mutation() is
  'Rejects update and delete operations so attendance-policy audit revisions remain immutable.';
comment on table public.workforce_payout_review_submissions is
  'Exact-period payout selections submitted for later review. Under Review locks attendance-policy changes for the affected Workforce period; approved/paid payroll remains the financial lock.';

revoke all on function public.workforce_attendance_capture_interval_is_locked(uuid, date, date),
  public.assert_workforce_attendance_capture_interval_open(uuid, date, date),
  public.guard_finalized_workforce_attendance_capture_setting(),
  public.save_workforce_attendance_capture_setting_internal(uuid, text, integer, integer, boolean, date, text, uuid),
  public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid),
  public.lock_workforce_attendance_policy_review_submission(),
  public.prevent_workforce_attendance_capture_history_mutation()
  from public, anon, authenticated;

grant execute on function public.workforce_attendance_capture_interval_is_locked(uuid, date, date),
  public.assert_workforce_attendance_capture_interval_open(uuid, date, date),
  public.guard_finalized_workforce_attendance_capture_setting(),
  public.save_workforce_attendance_capture_setting_internal(uuid, text, integer, integer, boolean, date, text, uuid),
  public.save_workforce_attendance_capture_setting(uuid, text, integer, date, text, uuid),
  public.lock_workforce_attendance_policy_review_submission(),
  public.prevent_workforce_attendance_capture_history_mutation()
  to service_role;

notify pgrst, 'reload schema';

commit;
