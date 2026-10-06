-- Cover every foreign-key lookup on uploaded payout deduction values.
-- These indexes keep referenced-row updates/deletes bounded as import history grows.
create index if not exists workforce_payout_deduction_values_workforce_fk_idx
  on public.workforce_payout_deduction_values (company_id, workforce_id);

create index if not exists workforce_payout_deduction_values_source_batch_fk_idx
  on public.workforce_payout_deduction_values (source_batch_id);

create index if not exists workforce_payout_deduction_values_source_row_fk_idx
  on public.workforce_payout_deduction_values (source_row_id);

create index if not exists workforce_payout_deduction_values_created_by_fk_idx
  on public.workforce_payout_deduction_values (created_by);

create index if not exists workforce_payout_deduction_values_updated_by_fk_idx
  on public.workforce_payout_deduction_values (updated_by);
