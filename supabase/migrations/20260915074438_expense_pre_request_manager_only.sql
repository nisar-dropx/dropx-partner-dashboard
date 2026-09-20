-- Expense pre-requests are approved only by the immediate reporting manager.
-- Finance approval remains part of the submitted reimbursement-claim workflow.

begin;

update public.hr_expense_claim_request_assignees finance_assignee
set
  status = 'skipped',
  decision_note = coalesce(
    finance_assignee.decision_note,
    'Removed from the expense pre-request route. Finance approval applies to the submitted reimbursement claim only.'
  ),
  updated_at = now()
where finance_assignee.assignee_role = 'finance_head'
  and finance_assignee.status = 'pending'
  and exists (
    select 1
    from public.hr_expense_claim_requests request
    where request.company_id = finance_assignee.company_id
      and request.id = finance_assignee.request_id
      and request.status = 'pending'
  )
  and exists (
    select 1
    from public.hr_expense_claim_request_assignees manager_assignee
    where manager_assignee.company_id = finance_assignee.company_id
      and manager_assignee.request_id = finance_assignee.request_id
      and manager_assignee.assignee_role = 'reporting_manager'
      and manager_assignee.status = 'pending'
  );

update public.hr_approval_workflow_catalog
set
  description = 'Employee and contractor expense claims. Expense pre-requests require only the immediate reporting manager. Finance approval applies to submitted reimbursement claims according to the configured claim workflow.',
  no_route_fallback_name = 'Immediate reporting manager required for expense pre-requests',
  updated_at = now()
where workflow_code = 'reimbursement';

commit;
