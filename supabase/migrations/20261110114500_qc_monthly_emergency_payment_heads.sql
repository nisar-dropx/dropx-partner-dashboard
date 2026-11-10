-- QC monthly / emergency bill payment heads for Payment Request dropdown.
-- Generator Fuel already exists; rename to the agreed label and backfill questions.
-- Remaining heads are cloned from ELECTRICITY_BILL (roles, modes, questions, approval steps).
-- Safe to re-run: inserts use NOT EXISTS / ON CONFLICT-style guards.

begin;

-- Keep the existing Generator Fuel head, with the QC-facing label.
update public.payment_heads
set
  name = 'Generator Diesel bill',
  external_id = 'Generator Diesel bill',
  updated_at = now()
where code = 'GENERATOR_FUEL';

with source as (
  select *
  from public.payment_heads
  where code = 'ELECTRICITY_BILL'
),
targets (code, name, external_id) as (
  values
    ('STATION_VISITS', 'Station visits', 'Station visits'),
    ('CORPORATION_BILL', 'Corporation bill', 'Corporation bill'),
    ('HK_MATERIAL', 'Housekeeping (HK) material', 'Housekeeping (HK) material'),
    ('OTHERS', 'Others', 'Others'),
    ('ADHOC_MANPOWER', 'Adoc Manpower', 'Adoc Manpower')
)
insert into public.payment_heads (
  company_id,
  code,
  name,
  external_id,
  requires_supporting_document,
  is_active,
  sort_order,
  final_approval_role_id,
  final_approval_role_ids,
  payment_process_role_ids,
  request_expense_approval,
  expense_approval_threshold,
  initial_approval_role_id,
  initial_approval_role_ids,
  supported_payment_modes,
  delivery_identity_policy
)
select
  source.company_id,
  target.code,
  target.name,
  target.external_id,
  source.requires_supporting_document,
  true,
  source.sort_order,
  source.final_approval_role_id,
  source.final_approval_role_ids,
  source.payment_process_role_ids,
  source.request_expense_approval,
  source.expense_approval_threshold,
  source.initial_approval_role_id,
  source.initial_approval_role_ids,
  source.supported_payment_modes,
  coalesce(source.delivery_identity_policy, 'none')
from source
cross join targets as target
where not exists (
  select 1
  from public.payment_heads existing
  where existing.company_id = source.company_id
    and existing.code = target.code
);

-- Questions for newly created heads, and for Generator Diesel when none exist yet.
insert into public.payment_head_questions (
  company_id,
  payment_head_id,
  question_text,
  answer_type,
  is_required,
  sort_order,
  dropdown_options,
  field_stage,
  date_rule,
  date_days
)
select
  target.company_id,
  target.id,
  question.question_text,
  question.answer_type,
  question.is_required,
  question.sort_order,
  question.dropdown_options,
  question.field_stage,
  question.date_rule,
  question.date_days
from public.payment_heads source
join public.payment_heads target
  on target.company_id = source.company_id
 and target.code in (
   'STATION_VISITS',
   'CORPORATION_BILL',
   'HK_MATERIAL',
   'OTHERS',
   'ADHOC_MANPOWER',
   'GENERATOR_FUEL'
 )
join public.payment_head_questions question
  on question.payment_head_id = source.id
where source.code = 'ELECTRICITY_BILL'
  and not exists (
    select 1
    from public.payment_head_questions existing
    where existing.payment_head_id = target.id
      and existing.question_text = question.question_text
      and coalesce(existing.field_stage, 'expense') = coalesce(question.field_stage, 'expense')
  );

-- Approval steps for the new heads (Generator Diesel already has role fields configured).
insert into public.payment_head_approval_steps (
  company_id,
  payment_head_id,
  step_order,
  candidates,
  is_required
)
select
  target.company_id,
  target.id,
  step.step_order,
  step.candidates,
  step.is_required
from public.payment_heads source
join public.payment_heads target
  on target.company_id = source.company_id
 and target.code in (
   'STATION_VISITS',
   'CORPORATION_BILL',
   'HK_MATERIAL',
   'OTHERS',
   'ADHOC_MANPOWER'
 )
join public.payment_head_approval_steps step
  on step.payment_head_id = source.id
where source.code = 'ELECTRICITY_BILL'
  and not exists (
    select 1
    from public.payment_head_approval_steps existing
    where existing.payment_head_id = target.id
      and existing.step_order = step.step_order
  );

commit;
