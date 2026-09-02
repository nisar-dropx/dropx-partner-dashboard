begin;

-- Attendance is rebuilt with an UPSERT. During the BEFORE INSERT phase of an
-- UPSERT, NEW.id is a fresh UUID even when the statement will ultimately
-- update an existing attendance_daily row. The leave exception must reference
-- that existing row, otherwise the FK rejects the biometric webhook.
create or replace function public.hr_apply_approved_leave_to_attendance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request_id uuid;
  v_leave_type_id uuid;
  v_employee_id uuid;
  v_contractor_id uuid;
  v_reviewed_by uuid;
  v_leave_name text;
  v_attendance_code text;
  v_attendance_label text;
  v_treatment text := 'review';
  v_worker_type text;
  v_worker_id uuid;
  v_attendance_id uuid;
  v_resolution text;
  v_resolution_status text;
  v_existing_resolution text;
begin
  select request.id, request.leave_type_id, request.employee_id, request.contractor_id,
         request.reviewed_by, leave_type.name, leave_type.attendance_code, leave_type.attendance_label
  into v_request_id, v_leave_type_id, v_employee_id, v_contractor_id,
       v_reviewed_by, v_leave_name, v_attendance_code, v_attendance_label
  from public.hr_leave_requests request
  join public.hr_leave_types leave_type on leave_type.id = request.leave_type_id
  where request.company_id = new.company_id
    and request.status = 'approved'
    and request.start_date <= new.punch_date and request.end_date >= new.punch_date
    and ((request.employee_id is not null and request.employee_id = new.employee_id)
      or (request.contractor_id is not null and request.contractor_id = coalesce(new.contractor_id, new.employee_id)))
  order by request.reviewed_at desc nulls last
  limit 1;

  if v_request_id is null then return new; end if;

  select exception.resolution into v_existing_resolution
  from public.hr_leave_attendance_exceptions exception
  where exception.company_id = new.company_id and exception.leave_request_id = v_request_id
    and exception.exception_date = new.punch_date and exception.resolution_status = 'resolved'
  limit 1;
  if v_existing_resolution = 'use_attendance' then return new; end if;

  v_worker_type := case when v_employee_id is not null then 'employee' else 'contractor' end;
  v_worker_id := coalesce(v_employee_id, v_contractor_id);

  -- Prefer the canonical daily row for an upsert conflict. For a genuinely
  -- new day, keep NEW.id and defer the FK until the parent row is inserted.
  select daily.id
  into v_attendance_id
  from public.attendance_daily daily
  where daily.company_id = new.company_id
    and daily.enrolment_id = new.enrolment_id
    and daily.punch_date = new.punch_date
  limit 1;

  if new.id is null then
    new.id := gen_random_uuid();
  end if;
  v_attendance_id := coalesce(v_attendance_id, new.id);

  select policy.leave_punch_treatment into v_treatment
  from public.hr_attendance_location_policies policy
  where policy.company_id = new.company_id
    and policy.location_id = coalesce(new.location_id, new.punch_in_location_id)
    and policy.is_active
  limit 1;
  v_treatment := coalesce(v_treatment, 'review');

  if coalesce(new.punch_count, 0) > 0 then
    v_resolution := case v_treatment when 'leave_wins' then 'keep_leave' when 'attendance_wins' then 'use_attendance' else null end;
    v_resolution_status := case when v_treatment = 'review' then 'pending' else 'resolved' end;
    insert into public.hr_leave_attendance_exceptions(
      company_id, leave_request_id, leave_type_id, attendance_id, worker_type, worker_id, exception_date,
      treatment, resolution_status, resolution, source_status, source_remark, punch_count, work_minutes, assigned_user_id, decided_at
    ) values (
      new.company_id, v_request_id, v_leave_type_id, v_attendance_id, v_worker_type, v_worker_id, new.punch_date,
      v_treatment, v_resolution_status, v_resolution, nullif(new.status, v_attendance_code), new.remark,
      new.punch_count, new.work_minutes, v_reviewed_by, case when v_resolution_status = 'resolved' then now() else null end
    ) on conflict(company_id, leave_request_id, exception_date) do update set
      attendance_id = excluded.attendance_id,
      punch_count = excluded.punch_count,
      work_minutes = excluded.work_minutes,
      assigned_user_id = coalesce(public.hr_leave_attendance_exceptions.assigned_user_id, excluded.assigned_user_id),
      source_status = coalesce(public.hr_leave_attendance_exceptions.source_status, excluded.source_status),
      source_remark = coalesce(public.hr_leave_attendance_exceptions.source_remark, excluded.source_remark),
      updated_at = now();

    if v_treatment = 'attendance_wins' then return new; end if;
    new.status := v_attendance_code;
    new.remark := case when v_treatment = 'review'
      then concat(v_attendance_label, ' · ', v_leave_name, ' · Punch conflict needs review')
      else concat(v_attendance_label, ' · ', v_leave_name, ' · Punches retained as evidence') end;
    return new;
  end if;

  new.status := v_attendance_code;
  new.remark := concat(v_attendance_label, ' · ', v_leave_name);
  return new;
end;
$function$;

alter table public.hr_leave_attendance_exceptions
  drop constraint hr_leave_attendance_exceptions_attendance_id_fkey;

alter table public.hr_leave_attendance_exceptions
  add constraint hr_leave_attendance_exceptions_attendance_id_fkey
  foreign key (attendance_id)
  references public.attendance_daily(id)
  on delete cascade
  deferrable initially deferred;

commit;
