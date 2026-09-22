-- Reimbursement pre-requests can include the Managing Partner as a parallel
-- fallback approver, so the assignee role constraint must allow that value.

begin;

alter table public.hr_expense_claim_request_assignees
  drop constraint if exists hr_expense_claim_request_assignees_assignee_role_check;

alter table public.hr_expense_claim_request_assignees
  add constraint hr_expense_claim_request_assignees_assignee_role_check
  check (assignee_role in ('reporting_manager', 'finance_head', 'managing_partner'));

commit;
