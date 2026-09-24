-- Canonical owner: dropx-partner-dashboard. People and One share these RPCs.
-- Pre-spend estimates have one manager owner; submitted claims keep Finance stages.
begin;

CREATE OR REPLACE FUNCTION public.hr_submit_expense_claim_request(p_company_id uuid, p_request_id uuid, p_worker_type text, p_worker_id uuid, p_claimant_person_id uuid, p_claimant_user_id uuid, p_assignment_id uuid, p_location_id uuid, p_designation_id uuid, p_purpose text, p_estimated_amount numeric, p_trip_from date, p_trip_to date, p_notes text, p_assignees jsonb, p_purpose_code text DEFAULT NULL::text, p_visit_station_ids uuid[] DEFAULT NULL::uuid[], p_expected_expenses jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  v_request_id uuid := coalesce(p_request_id, gen_random_uuid());
  v_request_no text;
  v_assignee jsonb;
  v_manager_count integer;
  v_seen uuid[] := array[]::uuid[];
  v_user_id uuid;
  v_station_ids uuid[] := coalesce(p_visit_station_ids, '{}'::uuid[]);
  v_expenses jsonb := coalesce(p_expected_expenses, '{}'::jsonb);
  v_enriched boolean := nullif(trim(coalesce(p_purpose_code, '')), '') is not null;
begin
  if p_worker_type not in ('employee', 'contractor') then raise exception 'Unsupported worker type.'; end if;
  if length(trim(coalesce(p_purpose, ''))) < 3 then raise exception 'Purpose must contain at least 3 characters.'; end if;
  if p_trip_from is not null and p_trip_to is not null and p_trip_to < p_trip_from then
    raise exception 'Trip end date cannot be before its start date.';
  end if;
  if p_estimated_amount is not null and p_estimated_amount < 0 then
    raise exception 'Estimated amount cannot be negative.';
  end if;
  if p_assignees is null or jsonb_typeof(p_assignees) <> 'array' or jsonb_array_length(p_assignees) < 1 then
    raise exception 'At least one pre-request approver is required.';
  end if;

  if v_enriched then
    if p_purpose_code not in (
      'station_visit', 'client_visit_meeting', 'recruitment_hiring_visit', 'audit_visit',
      'training_team_meeting', 'business_travel', 'local_travel', 'other'
    ) then
      raise exception 'Select a valid visit purpose.';
    end if;
    if p_purpose_code = 'other' and length(trim(coalesce(p_notes, ''))) < 3 then
      raise exception 'Remarks are required when purpose is Other.';
    end if;
    if p_estimated_amount is null or p_estimated_amount <= 0 then
      raise exception 'Enter a total estimated amount greater than zero.';
    end if;
    if cardinality(v_station_ids) < 1 then
      raise exception 'Select at least one visiting station or location.';
    end if;
    if exists (
      select 1
      from unnest(v_station_ids) as station_id(id)
      where not exists (
        select 1
        from public.stations station
        where station.company_id = p_company_id
          and station.id = station_id.id
          and station.is_active
      )
    ) then
      raise exception 'One or more selected stations are inactive or invalid.';
    end if;
    if jsonb_typeof(v_expenses) <> 'object' then
      raise exception 'Expected expense breakdown is invalid.';
    end if;
  end if;

  -- Older clients may still send Finance/Partner fallbacks. Normalize here so
  -- every client, list and reminder has one authoritative current owner.
  select count(distinct nullif(assignee->>'approver_user_id', ''))
  into v_manager_count
  from jsonb_array_elements(p_assignees) assignee
  where assignee->>'assignee_role' = 'reporting_manager';
  if v_manager_count <> 1 then
    raise exception 'Exactly one active reporting manager is required for an expense request.';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(p_assignees) assignee
    join public.profiles profile on profile.id = nullif(assignee->>'approver_user_id', '')::uuid
    where assignee->>'assignee_role' = 'reporting_manager'
      and profile.company_id = p_company_id and profile.is_active
  ) then
    raise exception 'The reporting manager must have an active login in this company.';
  end if;

  v_request_no := 'ERR-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(replace(v_request_id::text, '-', ''), 1, 8));
  insert into public.hr_expense_claim_requests(
    id, company_id, request_no, worker_type, employee_id, contractor_id, claimant_person_id, claimant_user_id,
    assignment_id, location_id, designation_id, purpose, purpose_code, estimated_amount, trip_from, trip_to,
    notes, visit_station_ids, expected_expenses, status
  ) values (
    v_request_id, p_company_id, v_request_no, p_worker_type,
    case when p_worker_type = 'employee' then p_worker_id end,
    case when p_worker_type = 'contractor' then p_worker_id end,
    p_claimant_person_id, p_claimant_user_id, p_assignment_id, p_location_id, p_designation_id,
    trim(p_purpose), nullif(trim(coalesce(p_purpose_code, '')), ''), p_estimated_amount, p_trip_from, p_trip_to,
    nullif(trim(coalesce(p_notes, '')), ''), v_station_ids, v_expenses, 'pending'
  );

  for v_assignee in
    select value from jsonb_array_elements(p_assignees)
    where value->>'assignee_role' = 'reporting_manager'
  loop
    v_user_id := (v_assignee->>'approver_user_id')::uuid;
    if v_user_id is null or v_user_id = any(v_seen) then
      continue;
    end if;
    v_seen := array_append(v_seen, v_user_id);
    insert into public.hr_expense_claim_request_assignees(
      company_id, request_id, approver_user_id, approver_person_id, assignee_role, status
    ) values (
      p_company_id, v_request_id,
      v_user_id,
      nullif(v_assignee->>'approver_person_id', '')::uuid,
      v_assignee->>'assignee_role',
      'pending'
    )
    on conflict (company_id, request_id, approver_user_id) do nothing;
  end loop;

  if not exists (
    select 1 from public.hr_expense_claim_request_assignees
    where company_id = p_company_id and request_id = v_request_id
  ) then
    raise exception 'At least one pre-request approver is required.';
  end if;

  return v_request_id;
end $function$;

CREATE OR REPLACE FUNCTION public.hr_decide_expense_claim_request(p_company_id uuid, p_request_id uuid, p_actor_user_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(request_id uuid, request_status text)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  v_request public.hr_expense_claim_requests%rowtype;
  v_assignee public.hr_expense_claim_request_assignees%rowtype;
begin
  if p_action not in ('approved','rejected') then raise exception 'Invalid pre-request decision.'; end if;
  if p_action='rejected' and length(trim(coalesce(p_note,'')))<3 then raise exception 'A reason is required when rejecting.'; end if;

  select claim_request.* into v_request
  from public.hr_expense_claim_requests claim_request
  where claim_request.company_id=p_company_id and claim_request.id=p_request_id
  for update;
  if not found or v_request.status<>'pending' then raise exception 'This reimbursement request is no longer awaiting approval.'; end if;

  select assignee.* into v_assignee
  from public.hr_expense_claim_request_assignees assignee
  where assignee.company_id=p_company_id
    and assignee.request_id=p_request_id
    and assignee.approver_user_id=p_actor_user_id
    and assignee.status='pending'
    and assignee.assignee_role='reporting_manager'
  for update;
  if not found then raise exception 'This reimbursement request is assigned to another approver.'; end if;

  update public.hr_expense_claim_request_assignees assignee
  set status=p_action,
      decision_note=nullif(trim(coalesce(p_note,'')),''),
      decided_at=now(),
      updated_at=now()
  where assignee.id=v_assignee.id;

  update public.hr_expense_claim_request_assignees assignee
  set status='skipped', updated_at=now()
  where assignee.company_id=p_company_id
    and assignee.request_id=p_request_id
    and assignee.status='pending'
    and assignee.id<>v_assignee.id;

  update public.hr_expense_claim_requests claim_request
  set status=p_action,
      decided_by=p_actor_user_id,
      decided_at=now(),
      decision_note=nullif(trim(coalesce(p_note,'')),''),
      updated_at=now()
  where claim_request.id=p_request_id;

  return query select p_request_id, p_action::text;
end $function$;

-- Do not alter completed approvals or the request itself. Preserve the old
-- fallback rows as skipped history with an explicit routing-correction note.
update public.hr_expense_claim_request_assignees fallback
set status = 'skipped',
    decision_note = concat_ws(E'\n', nullif(fallback.decision_note, ''),
      'Routing correction: estimate approval belongs to the reporting manager only. Claim approval stages are unchanged.'),
    updated_at = now()
where fallback.status = 'pending'
  and fallback.assignee_role in ('finance_head', 'managing_partner')
  and exists (
    select 1 from public.hr_expense_claim_requests request
    where request.company_id = fallback.company_id
      and request.id = fallback.request_id and request.status = 'pending'
  )
  and exists (
    select 1 from public.hr_expense_claim_request_assignees manager
    where manager.company_id = fallback.company_id
      and manager.request_id = fallback.request_id
      and manager.assignee_role = 'reporting_manager' and manager.status = 'pending'
  );

-- Replacing functions preserves the service-role-only ACL. Fail the release
-- rather than accidentally exposing an approval RPC to a browser role.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('hr_submit_expense_claim_request', 'hr_decide_expense_claim_request')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception 'Expense request RPC must remain service-role only.';
  end if;
end $$;
commit;
