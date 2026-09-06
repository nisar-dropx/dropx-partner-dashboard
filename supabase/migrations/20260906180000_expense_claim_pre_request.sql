-- Reimbursement pre-request (claim eligibility) before expense claim submission.
-- Single-layer dual assignee: reporting manager OR finance head (first decision wins).

begin;

create table if not exists public.hr_expense_claim_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_no text not null,
  worker_type text not null check (worker_type in ('employee','contractor')),
  employee_id uuid references public.employees(id) on delete restrict,
  contractor_id uuid references public.contractors(id) on delete restrict,
  claimant_person_id uuid not null references public.hr_people(id) on delete restrict,
  claimant_user_id uuid references public.profiles(id) on delete set null,
  assignment_id uuid not null references public.hr_work_assignments(id) on delete restrict,
  location_id uuid references public.stations(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  purpose text not null,
  estimated_amount numeric(12,2),
  trip_from date,
  trip_to date,
  notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  consumed_claim_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, request_no),
  unique(company_id, id),
  check ((worker_type='employee' and employee_id is not null and contractor_id is null) or (worker_type='contractor' and contractor_id is not null and employee_id is null)),
  check (trip_to is null or trip_from is null or trip_to >= trip_from),
  check (estimated_amount is null or estimated_amount >= 0),
  check (length(trim(purpose)) >= 3)
);

create table if not exists public.hr_expense_claim_request_assignees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  request_id uuid not null,
  approver_user_id uuid not null references public.profiles(id) on delete restrict,
  approver_person_id uuid references public.hr_people(id) on delete set null,
  assignee_role text not null check (assignee_role in ('reporting_manager','finance_head')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','skipped')),
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, request_id, assignee_role),
  unique(company_id, request_id, approver_user_id),
  foreign key(company_id, request_id) references public.hr_expense_claim_requests(company_id, id) on delete cascade
);

alter table public.hr_expense_claims
  add column if not exists claim_request_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'hr_expense_claims_claim_request_fk'
  ) then
    alter table public.hr_expense_claims
      add constraint hr_expense_claims_claim_request_fk
      foreign key(company_id, claim_request_id)
      references public.hr_expense_claim_requests(company_id, id) on delete restrict;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'hr_expense_claim_requests_consumed_claim_fk'
  ) then
    alter table public.hr_expense_claim_requests
      add constraint hr_expense_claim_requests_consumed_claim_fk
      foreign key(company_id, consumed_claim_id)
      references public.hr_expense_claims(company_id, id) on delete set null;
  end if;
end $$;

create index if not exists hr_expense_claim_requests_worker_idx
  on public.hr_expense_claim_requests(company_id, worker_type, employee_id, contractor_id, created_at desc);
create index if not exists hr_expense_claim_requests_status_idx
  on public.hr_expense_claim_requests(company_id, status, created_at desc);
create index if not exists hr_expense_claim_request_assignees_approver_idx
  on public.hr_expense_claim_request_assignees(company_id, approver_user_id, status, created_at);

alter table public.hr_expense_attachments drop constraint if exists hr_expense_attachments_file_size_check;
alter table public.hr_expense_attachments
  add constraint hr_expense_attachments_file_size_check check (file_size >= 0 and file_size <= 26214400);

update storage.buckets
set file_size_limit = 26214400
where id = 'hr-expense-receipts';

alter table public.hr_expense_notification_log
  alter column claim_id drop not null;
alter table public.hr_expense_notification_log
  add column if not exists claim_request_id uuid;

drop function if exists public.hr_submit_expense_claim(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,date,date,jsonb,jsonb);

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
    insert into public.hr_expense_claim_request_assignees(
      company_id,request_id,approver_user_id,approver_person_id,assignee_role,status
    ) values (
      p_company_id,v_request_id,
      (v_assignee->>'approver_user_id')::uuid,
      nullif(v_assignee->>'approver_person_id','')::uuid,
      v_assignee->>'assignee_role',
      'pending'
    );
  end loop;

  return v_request_id;
end $$;

create or replace function public.hr_decide_expense_claim_request(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_note text default null
) returns table(request_id uuid, request_status text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_request public.hr_expense_claim_requests%rowtype;
  v_assignee public.hr_expense_claim_request_assignees%rowtype;
begin
  if p_action not in ('approved','rejected') then raise exception 'Invalid pre-request decision.'; end if;
  if p_action='rejected' and length(trim(coalesce(p_note,'')))<3 then raise exception 'A reason is required when rejecting.'; end if;

  select * into v_request from public.hr_expense_claim_requests
  where company_id=p_company_id and id=p_request_id for update;
  if not found or v_request.status<>'pending' then raise exception 'This reimbursement request is no longer awaiting approval.'; end if;

  select * into v_assignee from public.hr_expense_claim_request_assignees
  where company_id=p_company_id and request_id=p_request_id and approver_user_id=p_actor_user_id and status='pending'
  for update;
  if not found then raise exception 'This reimbursement request is assigned to another approver.'; end if;

  update public.hr_expense_claim_request_assignees
  set status=p_action, decision_note=nullif(trim(coalesce(p_note,'')),''), decided_at=now(), updated_at=now()
  where id=v_assignee.id;

  update public.hr_expense_claim_request_assignees
  set status='skipped', updated_at=now()
  where company_id=p_company_id and request_id=p_request_id and status='pending' and id<>v_assignee.id;

  update public.hr_expense_claim_requests
  set status=p_action,
      decided_by=p_actor_user_id,
      decided_at=now(),
      decision_note=nullif(trim(coalesce(p_note,'')),''),
      updated_at=now()
  where id=p_request_id;

  return query select p_request_id, p_action::text;
end $$;

create or replace function public.hr_submit_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_worker_type text,
  p_worker_id uuid,
  p_claimant_person_id uuid,
  p_claimant_user_id uuid,
  p_assignment_id uuid,
  p_location_id uuid,
  p_designation_id uuid,
  p_policy_id uuid,
  p_payment_head_id uuid,
  p_purpose text,
  p_trip_from date,
  p_trip_to date,
  p_items jsonb,
  p_steps jsonb,
  p_claim_request_id uuid default null
) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_claim_id uuid:=coalesce(p_claim_id,gen_random_uuid());
  v_claim_no text;
  v_total numeric(12,2);
  v_item jsonb;
  v_step jsonb;
  v_request public.hr_expense_claim_requests%rowtype;
begin
  if p_worker_type not in ('employee','contractor') then raise exception 'Unsupported worker type.'; end if;
  if length(trim(coalesce(p_purpose,'')))<3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Add at least one expense item.'; end if;
  if jsonb_typeof(p_steps)<>'array' or jsonb_array_length(p_steps)=0 then raise exception 'No approval step is configured.'; end if;
  select coalesce(sum((item->>'amount')::numeric),0) into v_total from jsonb_array_elements(p_items) item;
  if v_total<=0 then raise exception 'Claim total must be greater than zero.'; end if;

  if p_claim_request_id is null then
    raise exception 'Submit a reimbursement claim only against an approved request.';
  end if;
  select * into v_request from public.hr_expense_claim_requests
  where company_id=p_company_id and id=p_claim_request_id for update;
  if not found then raise exception 'Reimbursement request was not found.'; end if;
  if v_request.status<>'approved' then raise exception 'Only an approved reimbursement request can be claimed.'; end if;
  if v_request.consumed_claim_id is not null then raise exception 'This reimbursement request already has a claim.'; end if;
  if v_request.worker_type<>p_worker_type
     or (p_worker_type='employee' and v_request.employee_id is distinct from p_worker_id)
     or (p_worker_type='contractor' and v_request.contractor_id is distinct from p_worker_id) then
    raise exception 'This reimbursement request belongs to another person.';
  end if;

  v_claim_no:='ER-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(substr(replace(v_claim_id::text,'-',''),1,8));
  insert into public.hr_expense_claims(
    id,company_id,claim_no,worker_type,employee_id,contractor_id,claimant_person_id,claimant_user_id,
    assignment_id,location_id,designation_id,policy_id,payment_head_id,purpose,trip_from,trip_to,
    total_claimed,status,current_step,submitted_at,claim_request_id
  ) values (
    v_claim_id,p_company_id,v_claim_no,p_worker_type,
    case when p_worker_type='employee' then p_worker_id end,
    case when p_worker_type='contractor' then p_worker_id end,
    p_claimant_person_id,p_claimant_user_id,p_assignment_id,p_location_id,p_designation_id,
    p_policy_id,p_payment_head_id,trim(p_purpose),p_trip_from,p_trip_to,v_total,'pending_approval',1,now(),p_claim_request_id
  );
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.hr_expense_items(id,company_id,claim_id,category_id,expense_date,merchant,description,amount,sort_order)
    values(
      coalesce(nullif(v_item->>'id','')::uuid,gen_random_uuid()),p_company_id,v_claim_id,(v_item->>'category_id')::uuid,
      (v_item->>'expense_date')::date,nullif(trim(v_item->>'merchant'),''),trim(v_item->>'description'),
      (v_item->>'amount')::numeric,coalesce((v_item->>'sort_order')::integer,100)
    );
  end loop;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    insert into public.hr_expense_approval_steps(company_id,claim_id,step_order,step_name,approver_user_id,approver_person_id,status)
    values(
      p_company_id,v_claim_id,(v_step->>'step_order')::smallint,v_step->>'step_name',
      (v_step->>'approver_user_id')::uuid,nullif(v_step->>'approver_person_id','')::uuid,
      case when (v_step->>'step_order')::smallint=1 then 'pending' else 'waiting' end
    );
  end loop;
  update public.hr_expense_claim_requests
  set consumed_claim_id=v_claim_id, updated_at=now()
  where id=p_claim_request_id;
  insert into public.hr_expense_events(company_id,claim_id,event_type,to_status,actor_user_id,actor_name,comments,metadata)
  values(
    p_company_id,v_claim_id,'submitted','pending_approval',p_claimant_user_id,null,'Claim submitted',
    jsonb_build_object('total',v_total,'item_count',jsonb_array_length(p_items),'claim_request_id',p_claim_request_id)
  );
  return v_claim_id;
end $$;

do $$ declare table_name text; begin
  foreach table_name in array array['hr_expense_claim_requests','hr_expense_claim_request_assignees'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('drop policy if exists %I on public.%I','service_role_all_'||table_name,table_name);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)','service_role_all_'||table_name,table_name);
  end loop;
end $$;

grant execute on function public.hr_submit_expense_claim_request(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,date,text,jsonb) to service_role;
grant execute on function public.hr_decide_expense_claim_request(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.hr_submit_expense_claim(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,date,date,jsonb,jsonb,uuid) to service_role;

commit;
