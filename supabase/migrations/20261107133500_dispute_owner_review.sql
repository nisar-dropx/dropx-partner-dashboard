-- Management review stays within existing role, page and station access.
create or replace function public.workforce_dispute_manager_can_review(p_company uuid,p_actor uuid,p_roles uuid[],p_station uuid)
returns boolean language sql volatile set search_path='' as $fn$
 select p_actor is not null and p_station is not null and exists (
  select 1 from public.user_roles r
  where r.company_id=p_company and r.is_active and r.id=any(coalesce(p_roles,'{}'::uuid[]))
   and regexp_replace(r.code,'^(OPERATIONS_|WORKFORCE_)','') in ('AOM','HLM','NH','NATIONAL_HEAD','REGIONAL_HEAD','ZONAL_HEAD','PROGRAM_HEAD','BH','FINMGR','FINANCE_HEAD','MANAGING_PARTNER','OWNER')
   and (r.code !~ '^(PEOPLE_|FLEET_|FINANCE_|RECRUIT_|TECH_)' or r.code='FINANCE_HEAD')
   and public.workforce_payout_dispute_first_eligible_role(p_company,p_station,array[r.id],false,
    array(select p.id from public.profiles p where p.company_id=p_company and p.id<>p_actor))=r.id
 )
$fn$;
revoke all on function public.workforce_dispute_manager_can_review(uuid,uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.workforce_dispute_manager_can_review(uuid,uuid,uuid[],uuid) to service_role;

