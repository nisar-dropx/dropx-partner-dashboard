-- Remap remaining DropX One / People pending approvals still owned by
-- NAGOOR PRAVEEN KUMAR (D0865) to his next solid-line manager INAYATH SHAIK.
-- Acting cover Nagoor → Inayath is already active (2026-10-17 .. 2027-01-15);
-- leave/WFH/attendance queues were empty; expense request assignees were not.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  from_person uuid := '4c6ddc16-15c8-480e-ba96-47ad084ad15b'; -- NAGOOR PRAVEEN KUMAR
  from_user uuid := 'b28bc14b-d397-4e36-b930-2837abe8e046';
  to_person uuid := 'b0c2aa8c-a99f-441d-9f7d-6a89ecb1f821'; -- INAYATH SHAIK
  to_user uuid := '2b2310ce-ffef-4b6c-8386-00a77dd724b7';
  cover_reason text := 'Acting cover: Nagoor unavailable · remapped to next manager Inayath Shaik';
  n int;
begin
  update public.hr_expense_claim_request_assignees
  set approver_user_id = to_user,
      approver_person_id = to_person,
      updated_at = now()
  where company_id = company
    and approver_user_id = from_user
    and status = 'pending';
  get diagnostics n = row_count;
  raise notice 'hr_expense_claim_request_assignees moved: % (%)', n, cover_reason;

  -- Future auto-covers that still point at Nagoor as the delegate (e.g. reportees on leave)
  -- should land on Inayath instead, matching the active acting cover.
  update public.hr_approval_delegations d
  set delegate_person_id = to_person,
      reason = coalesce(d.reason, '') || ' · retargeted to Inayath (Nagoor acting cover)',
      updated_at = now()
  where d.company_id = company
    and d.delegate_person_id = from_person
    and d.is_active
    and (d.effective_to is null or d.effective_to >= current_date)
    and d.effective_from >= current_date;
  get diagnostics n = row_count;
  raise notice 'future auto-delegations retargeted: %', n;
end $$;

commit;
