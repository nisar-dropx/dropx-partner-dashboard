-- Potential Package Loss (EDSP Daily_Potential Package Loss_Consolidated Report) for
-- Team Ops → Losses → Potential Loss. Written by nl-loss-cloak-worker as report
-- 'potential_loss', one period per daily snapshot. Report only: loss_apply_cases
-- archives into the recovery ledger for 'nl' and SLP kinds only, so these cases
-- are never assignable.
begin;

alter table public.loss_report_runs drop constraint if exists loss_report_runs_report_check;
alter table public.loss_report_runs add constraint loss_report_runs_report_check
  check (report in ('nl', 'slp_initial', 'slp_final', 'potential_loss'));

alter table public.loss_cases drop constraint if exists loss_cases_report_check;
alter table public.loss_cases add constraint loss_cases_report_check
  check (report in ('nl', 'slp_initial', 'slp_final', 'potential_loss'));

create index if not exists loss_cases_report_period_idx on public.loss_cases (report, period);

commit;
