-- Keep every post-midnight punch on the date its assigned/rostered shift began.
-- The database trigger protects every ingestion path; the repair block fixes
-- already-split workdays and rebuilds only the affected daily summaries.

begin;

create or replace function public.attendance_shift_window(
  p_company_id uuid,
  p_worker_id uuid,
  p_profile_type text,
  p_work_date date
)
returns table(start_time time without time zone, end_time time without time zone)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select s.start_time, s.end_time
  from public.hr_roster_entries re
  join public.hr_roster_plans rp
    on rp.id = re.plan_id
   and rp.company_id = re.company_id
   and rp.status = 'approved'
  join public.hr_shifts s
    on s.id = re.shift_id
   and s.company_id = re.company_id
  where re.company_id = p_company_id
    and re.worker_id = p_worker_id
    and re.roster_date = p_work_date
    and re.day_type = 'working'
  order by re.updated_at desc, re.id desc
  limit 1;
  if found then return; end if;

  if coalesce(p_profile_type, '') = 'employee' then
    return query
    select s.start_time, s.end_time
    from public.hr_employee_shift_assignments a
    join public.hr_shifts s
      on s.id = a.shift_id
     and s.company_id = a.company_id
    where a.company_id = p_company_id
      and a.employee_id = p_worker_id
      and a.effective_from <= p_work_date
      and (a.effective_to is null or a.effective_to >= p_work_date)
    order by a.effective_from desc, a.updated_at desc
    limit 1;
  elsif coalesce(p_profile_type, '') = 'workforce' then
    return query
    select s.start_time, s.end_time
    from public.hr_contractor_shift_assignments a
    join public.hr_shifts s
      on s.id = a.shift_id
     and s.company_id = a.company_id
    where a.company_id = p_company_id
      and a.workforce_id = p_worker_id
      and a.effective_from <= p_work_date
      and (a.effective_to is null or a.effective_to >= p_work_date)
    order by a.effective_from desc, a.updated_at desc
    limit 1;
  else
    return query
    select s.start_time, s.end_time
    from public.hr_contractor_shift_assignments a
    join public.hr_shifts s
      on s.id = a.shift_id
     and s.company_id = a.company_id
    where a.company_id = p_company_id
      and a.contractor_id = p_worker_id
      and a.effective_from <= p_work_date
      and (a.effective_to is null or a.effective_to >= p_work_date)
    order by a.effective_from desc, a.updated_at desc
    limit 1;
  end if;
end;
$$;

revoke all on function public.attendance_shift_window(uuid, uuid, text, date) from public;

create or replace function public.resolve_attendance_work_date(
  p_company_id uuid,
  p_enrolment_id text,
  p_punch_time timestamptz,
  p_worker_id uuid,
  p_profile_type text,
  p_exclude_punch_id uuid default null
)
returns date
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_calendar_date date := (p_punch_time at time zone 'Asia/Kolkata')::date;
  v_previous_date date := v_calendar_date - 1;
  v_enabled boolean := true;
  v_pairing_minutes integer := 180;
  v_maximum_minutes integer := 960;
  v_previous_count integer := 0;
  v_first_previous timestamptz;
  v_previous_start time without time zone;
  v_previous_end time without time zone;
  v_current_start time without time zone;
  v_previous_start_at timestamptz;
  v_previous_end_at timestamptz;
  v_current_start_at timestamptz;
  v_elapsed_minutes numeric;
begin
  if p_company_id is null or p_enrolment_id is null or p_punch_time is null then
    return v_calendar_date;
  end if;

  select
    coalesce(s.overnight_shift_pairing_enabled, true),
    greatest(0, coalesce(s.overnight_pairing_window_minutes, 180)),
    greatest(1, coalesce(s.maximum_daily_minutes, 960))
  into v_enabled, v_pairing_minutes, v_maximum_minutes
  from public.hr_company_settings s
  where s.company_id = p_company_id;

  if not v_enabled then return v_calendar_date; end if;

  select count(*)::integer, min(p.punch_time)
  into v_previous_count, v_first_previous
  from public.attendance_punches p
  where p.company_id = p_company_id
    and p.enrolment_id = p_enrolment_id
    and p.punch_date = v_previous_date
    and (p.calculated is true or p.is_flagged is true)
    and (p_exclude_punch_id is null or p.id <> p_exclude_punch_id);

  if v_previous_count = 0 then return v_calendar_date; end if;

  select sw.start_time, sw.end_time
  into v_previous_start, v_previous_end
  from public.attendance_shift_window(
    p_company_id, p_worker_id, p_profile_type, v_previous_date
  ) sw
  limit 1;

  if v_previous_start is not null and v_previous_end is not null then
    select sw.start_time
    into v_current_start
    from public.attendance_shift_window(
      p_company_id, p_worker_id, p_profile_type, v_calendar_date
    ) sw
    limit 1;

    v_previous_start_at := (v_previous_date + v_previous_start) at time zone 'Asia/Kolkata';
    if v_previous_end <= v_previous_start then
      v_previous_end_at := (v_calendar_date + v_previous_end) at time zone 'Asia/Kolkata';
    else
      v_previous_end_at := (v_previous_date + v_previous_end) at time zone 'Asia/Kolkata';
    end if;

    if p_punch_time > v_previous_end_at + make_interval(mins => v_pairing_minutes) then
      return v_calendar_date;
    end if;

    if v_current_start is not null then
      v_current_start_at := (v_calendar_date + v_current_start) at time zone 'Asia/Kolkata';
      if p_punch_time >= v_current_start_at then return v_calendar_date; end if;
    end if;

    return v_previous_date;
  end if;

  v_elapsed_minutes := extract(epoch from (p_punch_time - v_first_previous)) / 60;
  if v_elapsed_minutes <= 0 or v_elapsed_minutes > v_maximum_minutes then
    return v_calendar_date;
  end if;
  return case when mod(v_previous_count, 2) = 1 then v_previous_date else v_calendar_date end;
end;
$$;

revoke all on function public.resolve_attendance_work_date(uuid, text, timestamptz, uuid, text, uuid) from public;

create or replace function public.attendance_punch_set_work_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker_id uuid;
  v_profile_type text;
begin
  v_profile_type := coalesce(
    new.profile_type,
    case when new.employee_id is not null then 'employee' else null end
  );
  v_worker_id := case
    when v_profile_type = 'employee' then new.employee_id
    else coalesce(new.account_id, new.field_executive_id, new.contractor_id)
  end;
  new.punch_date := public.resolve_attendance_work_date(
    new.company_id,
    new.enrolment_id,
    new.punch_time,
    v_worker_id,
    v_profile_type,
    case when tg_op = 'UPDATE' then old.id else null end
  );
  return new;
end;
$$;

drop trigger if exists attendance_punches_set_work_date on public.attendance_punches;
create trigger attendance_punches_set_work_date
before insert or update of company_id, enrolment_id, punch_time, employee_id,
  field_executive_id, account_id, contractor_id, profile_type
on public.attendance_punches
for each row execute function public.attendance_punch_set_work_date();

-- Release the brief trigger DDL lock before the historical row-by-row repair.
-- Keeping the repair in a separate transaction avoids deadlocks with live
-- biometric inserts while still making the migration safe to rerun.
commit;
begin;

create temporary table attendance_overnight_affected (
  company_id uuid not null,
  enrolment_id text not null,
  punch_date date not null,
  primary key (company_id, enrolment_id, punch_date)
) on commit drop;

do $$
declare
  r record;
  v_resolved_date date;
  v_worker_id uuid;
  v_profile_type text;
begin
  for r in
    select p.*
    from public.attendance_punches p
    where p.calculated is true or p.is_flagged is true
    order by p.company_id, p.enrolment_id, p.punch_time, p.id
  loop
    v_profile_type := coalesce(
      r.profile_type,
      case when r.employee_id is not null then 'employee' else null end
    );
    v_worker_id := case
      when v_profile_type = 'employee' then r.employee_id
      else coalesce(r.account_id, r.field_executive_id, r.contractor_id)
    end;
    v_resolved_date := public.resolve_attendance_work_date(
      r.company_id,
      r.enrolment_id,
      r.punch_time,
      v_worker_id,
      v_profile_type,
      r.id
    );

    if v_resolved_date is distinct from r.punch_date then
      insert into attendance_overnight_affected(company_id, enrolment_id, punch_date)
      values
        (r.company_id, r.enrolment_id, r.punch_date),
        (r.company_id, r.enrolment_id, v_resolved_date)
      on conflict do nothing;

      update public.attendance_punches
      set punch_date = v_resolved_date
      where id = r.id;
    end if;
  end loop;
end;
$$;

with ordered as (
  select
    p.id,
    row_number() over (
      partition by p.company_id, p.enrolment_id, p.punch_date
      order by p.punch_time, p.id
    )::integer as punch_order
  from public.attendance_punches p
  join attendance_overnight_affected a
    on a.company_id = p.company_id
   and a.enrolment_id = p.enrolment_id
   and a.punch_date = p.punch_date
  where p.calculated is true
)
update public.attendance_punches p
set
  punch_order = o.punch_order,
  punch_label = case
    when mod(o.punch_order, 2) = 1 then 'In' || ((o.punch_order + 1) / 2)::text
    else 'Out' || (o.punch_order / 2)::text
  end
from ordered o
where p.id = o.id;

with affected_punches as (
  select p.*
  from public.attendance_punches p
  join attendance_overnight_affected a
    on a.company_id = p.company_id
   and a.enrolment_id = p.enrolment_id
   and a.punch_date = p.punch_date
  where p.calculated is true
),
summary as (
  select
    company_id,
    enrolment_id,
    punch_date,
    min(punch_time) as in_time,
    case when count(*) >= 2 then max(punch_time) end as out_time,
    count(*)::integer as punch_count,
    case
      when count(*) >= 2 then round(extract(epoch from (max(punch_time) - min(punch_time))) / 60)::integer
      else 0
    end as work_minutes,
    case when count(*) = 1 then 'Single punch' end as remark
  from affected_punches
  group by company_id, enrolment_id, punch_date
),
latest as (
  select distinct on (company_id, enrolment_id, punch_date)
    company_id,
    enrolment_id,
    punch_date,
    worker_type,
    profile_type,
    account_id,
    employee_id,
    field_executive_id,
    contractor_id,
    location_id,
    employee_code,
    station_code
  from affected_punches
  order by company_id, enrolment_id, punch_date, punch_time desc, id desc
),
resolved as (
  select
    s.*,
    l.worker_type,
    l.profile_type,
    l.account_id,
    l.employee_id,
    l.field_executive_id,
    l.contractor_id,
    coalesce(l.location_id, e.location_id, w.location_id, fe.location_id, c.location_id,
      v.location_id, wk.location_id, wh.location_id, wp.location_id) as resolved_location_id,
    coalesce(l.employee_code, e.employee_code, w.dropx_id, fe.dropx_id, c.dropx_id,
      v.dropx_id, wk.dropx_id, wh.dropx_id, wp.dropx_id) as resolved_code,
    coalesce(e.full_name, w.full_name, fe.full_name, c.full_name, v.full_name,
      wk.full_name, wh.full_name, wp.full_name) as resolved_name,
    l.station_code as punch_station_code
  from summary s
  join latest l
    on l.company_id = s.company_id
   and l.enrolment_id = s.enrolment_id
   and l.punch_date = s.punch_date
  left join public.employees e on e.id = l.employee_id and e.company_id = l.company_id
  left join public.workforce w on w.id = l.account_id and l.profile_type = 'workforce' and w.company_id = l.company_id
  left join public.field_executives fe on fe.id = coalesce(l.account_id, l.field_executive_id) and l.profile_type = 'field_executive' and fe.company_id = l.company_id
  left join public.contractors c on c.id = coalesce(l.account_id, l.contractor_id) and l.profile_type = 'contractor' and c.company_id = l.company_id
  left join public.vendors v on v.id = l.account_id and l.profile_type = 'vendor' and v.company_id = l.company_id
  left join public.workers wk on wk.id = l.account_id and l.profile_type = 'worker' and wk.company_id = l.company_id
  left join public.workforce_helpers wh on wh.id = l.account_id and l.profile_type in ('worker', 'helper') and wh.company_id = l.company_id
  left join public.workforce_pickers wp on wp.id = l.account_id and l.profile_type in ('worker', 'picker') and wp.company_id = l.company_id
)
update public.attendance_daily ad
set
  worker_type = r.worker_type,
  employee_id = r.employee_id,
  field_executive_id = r.field_executive_id,
  contractor_id = case when r.profile_type = 'contractor' then coalesce(r.account_id, r.contractor_id) end,
  workforce_id = case when r.profile_type = 'workforce' then r.account_id end,
  location_id = r.resolved_location_id,
  employee_code = coalesce(r.resolved_code, ad.employee_code),
  station_code = coalesce(st.station_code, r.punch_station_code, ad.station_code),
  worker_name = coalesce(r.resolved_name, ad.worker_name),
  in_time = r.in_time,
  out_time = r.out_time,
  punch_count = r.punch_count,
  work_minutes = r.work_minutes,
  status = 'P',
  remark = r.remark,
  updated_at = now()
from resolved r
left join public.stations st
  on st.id = r.resolved_location_id
 and st.company_id = r.company_id
where ad.company_id = r.company_id
  and ad.enrolment_id = r.enrolment_id
  and ad.punch_date = r.punch_date;

-- Preserve attendance_daily IDs (leave exceptions reference them) even when
-- every punch moved away from an old calendar date.
update public.attendance_daily ad
set
  in_time = null,
  out_time = null,
  punch_count = 0,
  work_minutes = 0,
  status = 'A',
  remark = 'No punch',
  updated_at = now()
from attendance_overnight_affected a
where ad.company_id = a.company_id
  and ad.enrolment_id = a.enrolment_id
  and ad.punch_date = a.punch_date
  and not exists (
    select 1
    from public.attendance_punches p
    where p.company_id = ad.company_id
      and p.enrolment_id = ad.enrolment_id
      and p.punch_date = ad.punch_date
      and p.calculated is true
  );

commit;
