create index if not exists payment_recovery_allocations_deduction_value_fk_idx
  on public.payment_recovery_allocations(deduction_value_id)
  where deduction_value_id is not null;
