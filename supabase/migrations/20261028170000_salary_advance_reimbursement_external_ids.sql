-- Bank-file Debit Remarks come from payment_heads.external_id.
-- Salary advances and DropX One reimbursements were missing that reference.
-- People / DropX One owns approval for both heads; empty Payment Approval Steps
-- are intentional.

begin;

update public.payment_heads
set
  external_id = 'Salary Advance',
  updated_at = now()
where upper(code) = 'SALARY_ADVANCE'
  and (external_id is null or btrim(external_id) = '');

update public.payment_heads
set
  external_id = '(Station Visit)',
  updated_at = now()
where upper(code) = 'EMPLOYEE_REIMBURSEMENT'
  and (external_id is null or btrim(external_id) = '');

commit;
