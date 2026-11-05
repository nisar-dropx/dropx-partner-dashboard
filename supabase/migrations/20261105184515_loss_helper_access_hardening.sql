-- These trigger functions run through their table triggers, not client RPCs.
revoke all on function public.enforce_loss_installment_amount_rules() from public, anon, authenticated;
revoke all on function public.nl_loss_record_source_history() from public, anon, authenticated;
grant execute on function public.enforce_loss_installment_amount_rules() to service_role;
grant execute on function public.nl_loss_record_source_history() to service_role;
alter function public.nl_recovery_month(jsonb, timestamptz) set search_path = pg_catalog, public;
