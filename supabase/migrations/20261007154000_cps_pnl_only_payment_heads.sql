-- Cost-reporting policy only. Payroll calculations and Finance's expense ledger
-- retain these payment heads. Membership is configured through OpsPulse master.
alter table public.ops_cps_component_policies
  drop constraint ops_cps_component_policies_mode_check;
alter table public.ops_cps_component_policies
  add constraint ops_cps_component_policies_mode_check
  check (mode in ('fleet','workforce','pnl_only'));
notify pgrst, 'reload schema';
