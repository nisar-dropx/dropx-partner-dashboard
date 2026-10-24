-- Optional expense-stage supporting attachments (up to 3 via existing multi-file UI)
-- for payment heads that currently only collect files at the payment stage (or never).
-- Idempotent: skips heads that already have an expense-stage file question with sort_order > 0.

insert into public.payment_head_questions (
  company_id,
  payment_head_id,
  question_text,
  answer_type,
  is_required,
  sort_order,
  dropdown_options,
  field_stage,
  date_rule
)
select
  h.company_id,
  h.id,
  'Supporting attachments',
  'file',
  false,
  coalesce((
    select max(q.sort_order)
    from public.payment_head_questions q
    where q.payment_head_id = h.id
      and q.field_stage = 'expense'
      and q.sort_order > 0
  ), 0) + 1,
  '["image","document"]',
  'expense',
  'any'
from public.payment_heads h
where coalesce(h.is_active, true)
  and h.code in (
    'ELECTRICITY_BILL',
    'BROADBAND_CHARGE',
    'DRINKING_WATER',
    'EMPLOYEE_REIMBURSEMENT',
    'FIELD_TRAVEL_REIMBURSEMENT'
  )
  and not exists (
    select 1
    from public.payment_head_questions q
    where q.payment_head_id = h.id
      and q.answer_type = 'file'
      and q.field_stage = 'expense'
      and q.sort_order > 0
  );
