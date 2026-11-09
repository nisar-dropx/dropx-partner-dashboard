-- Explicit false pauses only loss-clearance approval; absent settings remain enabled.
create or replace function public.assert_loss_payment_release(
 p_company uuid,p_station uuid,p_month text,p_scope text
) returns void language plpgsql security definer set search_path to ''
as $function$
declare v_review jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 -- Retain company, station, salary month and payroll source validation.
 if p_scope is null then raise exception 'Choose a valid payroll source.'; end if;
 v_review:=public.loss_payment_release_review(p_company,p_station,p_month,p_scope);
 if exists (
  select 1 from public.nl_loss_sources s
  where s.company_id=p_company
   and s.recovery_policy->'require_loss_payment_clearance'='false'::jsonb
 ) then return; end if;
 if v_review->'approval'='null'::jsonb or v_review->'approval' is null then
  raise exception '% · %: payment release approval is required or has expired after loss/payroll changes. Review loss clearance.',
   v_review->>'station',p_month;
 end if;
end $function$;
revoke all on function public.assert_loss_payment_release(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.assert_loss_payment_release(uuid,uuid,text,text) to service_role;
