-- Allow multiple finance-head pre-request assignees (one row per approver user).
-- Idempotent: safe if 20260907094500 already ran.

begin;

alter table public.hr_expense_claim_request_assignees
  drop constraint if exists hr_expense_claim_request_assignees_company_id_request_id_assignee_role_key;

-- Truncated / alternate names some Postgres installs keep.
alter table public.hr_expense_claim_request_assignees
  drop constraint if exists hr_expense_claim_request_assi_company_id_request_id_assigne_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hr_expense_claim_request_assignees'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%approver_user_id%'
  ) then
    alter table public.hr_expense_claim_request_assignees
      add constraint hr_expense_claim_request_assignees_company_id_request_id_approver_user_id_key
      unique (company_id, request_id, approver_user_id);
  end if;
end $$;

create or replace function public.hr_submit_expense_claim_request(
  p_company_id uuid,
  p_request_id uuid,
  p_worker_type text,
  p_worker_id uuid,
  p_claimant_person_id uuid,
  p_claimant_user_id uuid,
  p_assignment_id uuid,
  p_location_id uuid,
  p_designation_id uuid,
  p_purpose text,
  p_estimated_amount numeric,
  p_trip_from date,
  p_trip_to date,
  p_notes text,
  p_assignees jsonb
) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_request_id uuid:=coalesce(p_request_id,gen_random_uuid());
  v_request_no text;
  v_assignee jsonb;
  v_roles text[];
  v_seen uuid[] := array[]::uuid[];
  v_user_id uuid;
begin
  if p_worker_type not in ('employee','contractor') then raise exception 'Unsupported worker type.'; end if;
  if length(trim(coalesce(p_purpose,'')))<3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if p_trip_from is not null and p_trip_to is not null and p_trip_to < p_trip_from then raise exception 'Trip end date cannot be before its start date.'; end if;
  if p_estimated_amount is not null and p_estimated_amount < 0 then raise exception 'Estimated amount cannot be negative.'; end if;
  if jsonb_typeof(p_assignees)<>'array' or jsonb_array_length(p_assignees)<1 then raise exception 'At least one pre-request approver is required.'; end if;

  select array_agg(distinct assignee->>'assignee_role') into v_roles from jsonb_array_elements(p_assignees) assignee;
  if v_roles is null or not ('reporting_manager' = any(v_roles) or 'finance_head' = any(v_roles)) then
    raise exception 'Pre-request must include a reporting manager or finance head assignee.';
  end if;

  v_request_no:='ERR-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(substr(replace(v_request_id::text,'-',''),1,8));
  insert into public.hr_expense_claim_requests(
    id,company_id,request_no,worker_type,employee_id,contractor_id,claimant_person_id,claimant_user_id,
    assignment_id,location_id,designation_id,purpose,estimated_amount,trip_from,trip_to,notes,status
  ) values (
    v_request_id,p_company_id,v_request_no,p_worker_type,
    case when p_worker_type='employee' then p_worker_id end,
    case when p_worker_type='contractor' then p_worker_id end,
    p_claimant_person_id,p_claimant_user_id,p_assignment_id,p_location_id,p_designation_id,
    trim(p_purpose),p_estimated_amount,p_trip_from,p_trip_to,nullif(trim(coalesce(p_notes,'')),''),'pending'
  );

  for v_assignee in select * from jsonb_array_elements(p_assignees) loop
    v_user_id := (v_assignee->>'approver_user_id')::uuid;
    if v_user_id is null or v_user_id = any(v_seen) then
      continue;
    end if;
    v_seen := array_append(v_seen, v_user_id);
    insert into public.hr_expense_claim_request_assignees(
      company_id,request_id,approver_user_id,approver_person_id,assignee_role,status
    ) values (
      p_company_id,v_request_id,
      v_user_id,
      nullif(v_assignee->>'approver_person_id','')::uuid,
      v_assignee->>'assignee_role',
      'pending'
    )
    on conflict (company_id, request_id, approver_user_id) do nothing;
  end loop;

  if not exists (
    select 1 from public.hr_expense_claim_request_assignees
    where company_id=p_company_id and request_id=v_request_id
  ) then
    raise exception 'At least one pre-request approver is required.';
  end if;

  return v_request_id;
end $$;

grant execute on function public.hr_submit_expense_claim_request(
  uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,date,text,jsonb
) to service_role;

commit;
