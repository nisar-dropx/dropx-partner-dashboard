-- OpsPulse reads canonical People cases. Scope comes only from verified server authorization.
-- No detection sync, HR follow-up writes, payroll changes, or private HR notes.
create function public.ops_people_unplanned_leave_view(
  p_company_id uuid, p_user_id uuid, p_from date, p_to date,
  p_owner boolean default false, p_all_locations boolean default false,
  p_location_ids uuid[] default '{}', p_backlog boolean default true
) returns jsonb language plpgsql stable security invoker set search_path = '' as $fn$
declare v_result jsonb; v_grace integer; v_enabled boolean;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 30
    or p_to > (now() at time zone 'Asia/Kolkata')::date
  then raise exception 'Choose a valid date range of up to 31 days.' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id and company_id = p_company_id and is_active)
  then raise exception 'Active company access required.' using errcode = '42501'; end if;
  if not p_owner and not exists (select 1 from public.company_product_memberships
    where company_id = p_company_id and user_id = p_user_id and product_code = 'operations' and is_active)
  then raise exception 'Operations membership required.' using errcode = '42501'; end if;
  select unplanned_leave_grace_minutes, unplanned_leave_enabled into v_grace, v_enabled
    from public.hr_company_settings where company_id = p_company_id;
  if v_grace is null or v_enabled is null then raise exception 'Attendance policy unavailable.'; end if;

  with targets as materialized (
    select c.*, coalesce(e.biometric_id, k.biometric_id) as biometric_id,
      coalesce(e.people_lifecycle_status, k.people_lifecycle_status,
        case when coalesce(e.is_active,k.is_active,false) then 'active' else 'suspended' end) employment_status,
      coalesce(e.is_active, k.is_active, false) employment_active,
      coalesce(e.last_working_date, k.last_working_date) last_working_date,
      coalesce(nullif(trim(loc.cluster),''),nullif(trim(loc.cluster_name),'')) cluster, loc.region,
      jsonb_build_object('id',s.id,'label',s.label,'tone',s.tone,'display_order',s.display_order,
        'is_terminal',s.is_terminal,'is_active',s.is_active) status
    from public.hr_unplanned_leave_cases c
    join public.hr_unplanned_leave_statuses s on s.id = c.status_id and s.company_id = c.company_id
    left join public.employees e on c.worker_type = 'employee' and e.company_id = c.company_id and e.id = c.worker_id and e.deleted_at is null
    left join public.contractors k on c.worker_type = 'contractor' and k.company_id = c.company_id and k.id = c.worker_id and k.deleted_at is null
    left join public.stations loc on loc.company_id = c.company_id and loc.id = c.location_id
    where c.company_id = p_company_id
      and (p_all_locations or c.location_id = any(coalesce(p_location_ids,'{}'::uuid[])))
      and c.attendance_date <= p_to
      and (c.attendance_date >= p_from or (p_backlog and c.excluded_at is null and not s.is_terminal))
  ), evidence as materialized (
    select c.id,
      least(d.first_in, p.first_in) as first_in,
      greatest(d.last_punch, p.last_punch) as last_punch,
      greatest(d.last_out, p.last_out) as last_out,
      greatest(coalesce(d.punch_count, 0), coalesce(p.punch_count, 0))::integer as punch_count,
      coalesce(p.pending, false) as pending,
      exists (select 1 from public.hr_leave_requests l
        where l.company_id = c.company_id and l.status = 'approved'
          and c.attendance_date between l.start_date and l.end_date
          and ((c.worker_type = 'employee' and l.employee_id = c.worker_id)
            or (c.worker_type = 'contractor' and l.contractor_id = c.worker_id))) as approved_leave
    from targets c
    left join lateral (
      select min(a.in_time) as first_in, max(greatest(a.in_time, a.out_time)) as last_punch,
        max(a.out_time) as last_out,
        max(greatest(coalesce(a.punch_count, 0), case when a.in_time is not null or a.out_time is not null then 1 else 0 end)) as punch_count
      from public.attendance_daily a
      where a.company_id = c.company_id and a.punch_date = c.attendance_date
        and a.status <> 'U' and a.workforce_id is null and a.field_executive_id is null
        and ((c.worker_type = 'employee' and a.worker_type = 'employee')
          or (c.worker_type = 'contractor' and a.worker_type in ('contractor', 'individual_contract')))
        and (coalesce(case when c.worker_type = 'employee' then a.employee_id else a.contractor_id end, a.employee_id) = c.worker_id
          or (a.employee_id is null and a.contractor_id is null and nullif(c.biometric_id, '') is not null
            and a.enrolment_id = any(array[c.biometric_id, ltrim(c.biometric_id, '0'), lpad(ltrim(c.biometric_id, '0'), 6, '0'), lpad(ltrim(c.biometric_id, '0'), 8, '0')])))
    ) d on true
    left join lateral (
      select min(coalesce(a.client_captured_at, a.punch_time)) as first_in,
        max(coalesce(a.client_captured_at, a.punch_time)) as last_punch,
        max(coalesce(a.client_captured_at, a.punch_time)) filter (where a.punch_label ilike 'out%') as last_out,
        count(*) as punch_count, bool_or(a.calculated = false) as pending
      from public.attendance_punches a
      where a.company_id = c.company_id and a.punch_date = c.attendance_date
        and a.field_executive_id is null and coalesce(a.profile_type, '') not in ('workforce', 'field_executive')
        and ((c.worker_type = 'employee' and a.worker_type = 'employee')
          or (c.worker_type = 'contractor' and a.worker_type in ('contractor', 'individual_contract')))
        and (coalesce(case when c.worker_type = 'employee' then a.employee_id else a.contractor_id end, a.account_id, a.employee_id) = c.worker_id
          or (a.account_id is null and a.employee_id is null and a.contractor_id is null and nullif(c.biometric_id, '') is not null
            and a.enrolment_id = any(array[c.biometric_id, ltrim(c.biometric_id, '0'), lpad(ltrim(c.biometric_id, '0'), 6, '0'), lpad(ltrim(c.biometric_id, '0'), 8, '0')])))
    ) p on true

  ), projected as (
    select c.id,c.attendance_date,c.worker_type,c.worker_id,c.worker_name,c.worker_code,c.contact_number,
      c.location_id,c.location_code,c.location_name,c.cluster,c.region,c.department_name,c.designation_name,
      c.shift_label,c.shift_start,c.shift_end,c.employment_status,c.employment_active,c.last_working_date,
      c.reason,c.last_hr_update_at,c.status,
      e.first_in first_punch_at,e.last_punch last_punch_at,e.last_out check_out_at,
      e.punch_count recorded_punch_count,e.pending pending_punches,
      case when e.punch_count > 0 or e.approved_leave then coalesce(c.excluded_at,now()) else c.excluded_at end excluded_at,
      case when e.punch_count > 0 then 'Punch recorded' when e.approved_leave then 'Approved leave' else c.exclusion_reason end exclusion_reason
    from targets c join evidence e on e.id=c.id
  ) select jsonb_build_object(
    'from',p_from,'to',p_to,'today',(now() at time zone 'Asia/Kolkata')::date,
    'checkedAt',now(),'enabled',v_enabled,'graceMinutes',v_grace,
    'rows',(select coalesce(jsonb_agg(to_jsonb(r) order by r.attendance_date desc,r.worker_name),'[]'::jsonb) from projected r),
    'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'code',l.station_code,'name',l.station_name,
      'cluster',coalesce(nullif(trim(l.cluster),''),nullif(trim(l.cluster_name),'')),'region',l.region) order by l.station_code),'[]'::jsonb)
      from public.stations l where l.company_id=p_company_id and (l.is_active or exists(select 1 from targets c where c.location_id=l.id))
      and (p_all_locations or l.id=any(coalesce(p_location_ids,'{}'::uuid[])))),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'tone',s.tone,
      'display_order',s.display_order,'is_terminal',s.is_terminal,'is_active',s.is_active) order by s.display_order),'[]'::jsonb)
      from public.hr_unplanned_leave_statuses s where s.company_id=p_company_id)
  ) into v_result;
  return v_result;
end;
$fn$;
revoke all on function public.ops_people_unplanned_leave_view(uuid,uuid,date,date,boolean,boolean,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.ops_people_unplanned_leave_view(uuid,uuid,date,date,boolean,boolean,uuid[],boolean) to service_role;
