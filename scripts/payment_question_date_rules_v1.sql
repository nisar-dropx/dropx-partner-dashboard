alter table public.payment_head_questions
  add column if not exists date_rule text not null default 'any',
  add column if not exists date_days integer;

alter table public.payment_head_questions
  drop constraint if exists payment_head_questions_date_rule_check;

alter table public.payment_head_questions
  add constraint payment_head_questions_date_rule_check
  check (date_rule in ('any', 'today', 'past', 'future'));

alter table public.payment_head_questions
  drop constraint if exists payment_head_questions_date_days_check;

alter table public.payment_head_questions
  add constraint payment_head_questions_date_days_check
  check (date_days is null or date_days > 0);
