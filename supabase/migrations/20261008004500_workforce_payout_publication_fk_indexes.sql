-- Cover every foreign key introduced or extended by the payout publication and
-- dispute workflow. These indexes keep deletes, joins, and scoped review reads
-- bounded as publication history grows.

create index if not exists workforce_payout_publications_published_by_idx
  on public.workforce_payout_publications (published_by);

create index if not exists workforce_payout_publications_station_id_idx
  on public.workforce_payout_publications (station_id);

create index if not exists workforce_payout_publications_workforce_id_idx
  on public.workforce_payout_publications (workforce_id);

create index if not exists workforce_payout_disputes_correction_id_idx
  on public.workforce_payout_disputes (correction_id);

create index if not exists workforce_payout_disputes_resolved_by_idx
  on public.workforce_payout_disputes (resolved_by);

create index if not exists workforce_payout_disputes_station_id_idx
  on public.workforce_payout_disputes (station_id);

create index if not exists workforce_payout_disputes_workforce_id_idx
  on public.workforce_payout_disputes (workforce_id);

create index if not exists workforce_payout_dispute_events_company_id_idx
  on public.workforce_payout_dispute_events (company_id);

create index if not exists workforce_payout_corrections_payroll_run_id_idx
  on public.workforce_payout_corrections (payroll_run_id);

create index if not exists workforce_payout_corrections_requested_by_idx
  on public.workforce_payout_corrections (requested_by);

create index if not exists workforce_payout_corrections_reviewed_by_idx
  on public.workforce_payout_corrections (reviewed_by);

create index if not exists workforce_payout_corrections_station_id_idx
  on public.workforce_payout_corrections (station_id);

create index if not exists workforce_payout_corrections_workforce_id_idx
  on public.workforce_payout_corrections (workforce_id);
