
-- Activate the requested roles using existing station scopes. No membership or location access is widened.
do $$
declare actor record; initial_roles uuid[]; final_roles uuid[]; processor_roles uuid[];
begin
 select p.id,p.company_id into actor from public.profiles p where lower(p.email)='jamsheer@dropxlogistics.com' and p.is_active;
 if not found then return; end if;
 insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
 select actor.company_id,r.id,p.id,true,false,true
 from public.user_roles r join public.app_pages p
 on (p.company_id=actor.company_id or p.company_id is null) and p.is_active
 and (p.code='ops_workforce_payout_disputes' or (p.code='ops_workforce_payouts' and r.code='OPERATIONS_ACCOUNTS'))
 where r.company_id=actor.company_id and r.is_active
 and r.code in ('OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_FINMGR','OPERATIONS_ACCOUNTS')
 on conflict (company_id,role_id,page_id) do update set can_view=true,can_edit=true,updated_at=clock_timestamp();
 select array_agg(id order by array_position(array['OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_NH'],code))
 into initial_roles from public.user_roles where company_id=actor.company_id and is_active and code in ('OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_NH');
 select array_agg(id order by array_position(array['OPERATIONS_FINMGR','OWNER'],code))
 into final_roles from public.user_roles where company_id=actor.company_id and is_active and code in ('OPERATIONS_FINMGR','OWNER');
 select array_agg(id) into processor_roles from public.user_roles where company_id=actor.company_id and is_active and code='OPERATIONS_ACCOUNTS';
 if cardinality(initial_roles)<>3 or cardinality(final_roles)<>2 or cardinality(processor_roles)<>1 then
  raise exception 'Required dispute workflow roles missing';
 end if;
 if not exists(select 1 from public.workforce_payout_dispute_workflows where company_id=actor.company_id and station_id is null) then
  perform public.workforce_upsert_dispute_workflow_v2(actor.company_id,null,initial_roles,final_roles,processor_roles,actor.id,0,true,2);
 end if;
end $$;

