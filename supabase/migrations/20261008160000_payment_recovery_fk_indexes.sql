begin;

-- Index every foreign-key referencing side so deletes, joins and integrity
-- checks remain bounded as the Recovery register grows.
create index if not exists payment_recovery_batches_created_by_idx
  on public.payment_recovery_import_batches(created_by)
  where created_by is not null;

create index if not exists payment_recovery_cases_batch_company_idx
  on public.payment_recovery_cases(company_id, source_batch_id)
  where source_batch_id is not null;
create index if not exists payment_recovery_cases_created_by_idx
  on public.payment_recovery_cases(created_by)
  where created_by is not null;
create index if not exists payment_recovery_cases_updated_by_idx
  on public.payment_recovery_cases(updated_by)
  where updated_by is not null;

create index if not exists payment_recovery_allocations_station_company_idx
  on public.payment_recovery_allocations(company_id, station_id)
  where station_id is not null;

create index if not exists payment_recovery_events_allocation_case_idx
  on public.payment_recovery_events(company_id, recovery_case_id, allocation_id)
  where allocation_id is not null;
create index if not exists payment_recovery_events_created_by_idx
  on public.payment_recovery_events(created_by)
  where created_by is not null;
create index if not exists payment_recovery_events_reversed_by_idx
  on public.payment_recovery_events(reversed_by)
  where reversed_by is not null;

commit;
