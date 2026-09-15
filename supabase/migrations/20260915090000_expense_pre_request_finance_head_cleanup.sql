-- Fixes the duplicate "Current" approval-step display bug from the Review
-- request journey UI (screenshot: two Finance Head rows + a Reporting Manager
-- row all shown as "Current" simultaneously on the same pre-request).
--
-- Root cause: a pending finance_head assignee row was left behind forever once
-- its sibling reporting_manager assignee had already been decided, because an
-- earlier same-day migration's cleanup only matched while the manager row was
-- still 'pending'. The single-current-step rendering fix in
-- apps/connect/src/components/connect-approval-inbox.tsx (journeyStatus /
-- ApprovalJourneyCell) already prevents this from being visually wrong even
-- when multiple rows are 'pending', so a heavier structural fix is not needed
-- here - this migration only backfills the specific stale rows left behind
-- by that gap.
--
-- Finance Head and Managing Partner are legitimate parallel pre-request
-- approvers (see resolveExpenseClaimRequestAssignees in
-- apps/connect/src/lib/connect-expense-data.ts - any one of reporting
-- manager / finance head / managing partner may approve a pre-request,
-- first decision wins), so this migration does NOT suppress future
-- finance_head/managing_partner assignee rows - it only cleans up rows that
-- were already stuck pending from before that immediate-reporting-manager-only
-- window (20260907133000 through 20260915074438).

begin;

update public.hr_expense_claim_request_assignees finance_assignee
set
  status = 'skipped',
  decision_note = coalesce(
    finance_assignee.decision_note,
    'Superseded: the reporting manager already decided this pre-request before the parallel Finance Head/Managing Partner approver route existed.'
  ),
  updated_at = now()
where finance_assignee.assignee_role = 'finance_head'
  and finance_assignee.status = 'pending'
  and exists (
    select 1
    from public.hr_expense_claim_request_assignees manager_assignee
    where manager_assignee.company_id = finance_assignee.company_id
      and manager_assignee.request_id = finance_assignee.request_id
      and manager_assignee.assignee_role = 'reporting_manager'
      and manager_assignee.status <> 'pending'
  )
  and exists (
    select 1
    from public.hr_expense_claim_requests request
    where request.company_id = finance_assignee.company_id
      and request.id = finance_assignee.request_id
      and request.status <> 'pending'
  );

commit;
