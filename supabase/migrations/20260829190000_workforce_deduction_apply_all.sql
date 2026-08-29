alter table public.workforce_deduction_heads
  add column if not exists applies_to_all boolean not null default false;

comment on column public.workforce_deduction_heads.applies_to_all is
  'When true, the deduction is automatically applied to every workforce payout without individual assignment.';
