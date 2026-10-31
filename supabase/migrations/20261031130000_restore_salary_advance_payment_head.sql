-- Salary advances are approved in People / DropX One and enter Payments
-- already approved for Finance processing. They must not use the expense
-- approval-step master. This also repairs databases that ran the earlier
-- fuzzy fleet-head seed where "Salary advance" matched "%van%".

delete from public.payment_head_approval_steps step
using public.payment_heads head
where head.id = step.payment_head_id
  and head.company_id = step.company_id
  and upper(head.code) in ('SALARY_ADVANCE', 'PAY_ADVANCE', 'ADVANCE');

update public.payment_heads
set initial_approval_role_id = null,
    initial_approval_role_ids = '{}'::uuid[],
    final_approval_role_id = null,
    final_approval_role_ids = '{}'::uuid[],
    updated_at = now()
where upper(code) in ('SALARY_ADVANCE', 'PAY_ADVANCE', 'ADVANCE');
