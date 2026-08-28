-- DropX One: cancel or edit pending workforce leave requests.

create or replace function public.hr_cancel_workforce_leave_request(
  p_company_id uuid,
  p_request_id uuid,
  p_worker_type text,
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.hr_leave_requests%rowtype;
begin
  if p_worker_type not in ('employee', 'contractor') then
    raise exception 'Time off is available only for employees and independent contractors.';
  end if;

  select * into request_row
  from public.hr_leave_requests
  where company_id = p_company_id and id = p_request_id
  for update;

  if request_row.id is null then raise exception 'Leave request was not found.'; end if;
  if request_row.status <> 'pending' then raise exception 'Only a pending request can be withdrawn.'; end if;
  if p_worker_type = 'employee' and request_row.employee_id is distinct from p_profile_id then
    raise exception 'You can withdraw only your own leave request.';
  end if;
  if p_worker_type = 'contractor' and request_row.contractor_id is distinct from p_profile_id then
    raise exception 'You can withdraw only your own leave request.';
  end if;

  update public.hr_leave_requests
  set status = 'cancelled', updated_at = now()
  where id = p_request_id and company_id = p_company_id and status = 'pending';

  update public.hr_leave_approval_steps
  set status = 'skipped', updated_at = now()
  where company_id = p_company_id and request_id = p_request_id and status in ('queued', 'pending');
end;
$$;

create or replace function public.hr_update_workforce_leave_request(
  p_company_id uuid,
  p_request_id uuid,
  p_worker_type text,
  p_profile_id uuid,
  p_leave_type_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.hr_leave_requests%rowtype;
begin
  if p_worker_type not in ('employee', 'contractor') then
    raise exception 'Time off is available only for employees and independent contractors.';
  end if;
  if p_end_date < p_start_date then raise exception 'The end date cannot be before the start date.'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Enter a valid reason.'; end if;
  if not exists (
    select 1 from public.hr_leave_types where company_id = p_company_id and id = p_leave_type_id and is_active
  ) then raise exception 'Leave type does not belong to the selected company or is inactive.'; end if;

  select * into request_row
  from public.hr_leave_requests
  where company_id = p_company_id and id = p_request_id
  for update;

  if request_row.id is null then raise exception 'Leave request was not found.'; end if;
  if request_row.status <> 'pending' then raise exception 'Only a pending request can be edited.'; end if;
  if p_worker_type = 'employee' and request_row.employee_id is distinct from p_profile_id then
    raise exception 'You can edit only your own leave request.';
  end if;
  if p_worker_type = 'contractor' and request_row.contractor_id is distinct from p_profile_id then
    raise exception 'You can edit only your own leave request.';
  end if;

  if exists (
    select 1 from public.hr_leave_requests request
    where request.company_id = p_company_id
      and request.id <> p_request_id
      and (
        (p_worker_type = 'employee' and request.employee_id = p_profile_id)
        or (p_worker_type = 'contractor' and request.contractor_id = p_profile_id)
      )
      and request.status in ('pending', 'approved')
      and daterange(request.start_date, request.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then raise exception 'A pending or approved request already overlaps these dates.'; end if;

  update public.hr_leave_requests
  set leave_type_id = p_leave_type_id,
      start_date = p_start_date,
      end_date = p_end_date,
      reason = btrim(p_reason),
      updated_at = now()
  where id = p_request_id and company_id = p_company_id and status = 'pending';
end;
$$;

revoke all on function public.hr_cancel_workforce_leave_request(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.hr_update_workforce_leave_request(uuid, uuid, text, uuid, uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.hr_cancel_workforce_leave_request(uuid, uuid, text, uuid) to service_role;
grant execute on function public.hr_update_workforce_leave_request(uuid, uuid, text, uuid, uuid, date, date, text) to service_role;
