-- One user confirmation approves submitted locations and issues a single bank file.
-- The existing issuer still owns eligibility, clearance, bank validation and deduplication.
create or replace function public.people_finance_override_allowed(p_company uuid,p_actor uuid,p_station uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p
 join public.company_product_memberships m on m.user_id=p.id and m.company_id=p.company_id and m.is_active
 join public.user_roles role on role.id=m.role_id and role.is_active
 where p.id=p_actor and p.company_id=p_company and p.is_active and m.product_code='finance'
 and regexp_replace(upper(role.code),'^FINANCE_','') in ('MP','MANAGING_PARTNER')
 and (m.has_all_location_access or role.location_access_mode='all_locations' or p_station=any(m.location_scope_ids))
 and exists(select 1 from public.stations s where s.id=p_station and s.company_id=p_company))
$$;
revoke all on function public.people_finance_override_allowed(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.people_finance_override_allowed(uuid,uuid,uuid) to service_role;

create or replace function public.people_finance_approve_and_issue(
 p_company uuid,p_requests uuid[],p_actor uuid,p_operation uuid,p_bank uuid,p_value_date date,p_expected jsonb,p_override_reason text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare request_id uuid; r public.people_finance_requests; preview jsonb; expected jsonb;
 updated_expected jsonb:=p_expected; station_code text; salary_month text; needs_override boolean;
begin
 if coalesce(cardinality(p_requests),0) not between 1 and 100 or array_position(p_requests,null) is not null
 then raise exception 'Select 1 to 100 payroll locations.'; end if;
 if cardinality(p_requests)<>(select count(distinct x) from unnest(p_requests) x)
 then raise exception 'A location submission was selected more than once.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 -- A retry retrieves the original instructions; it must not approve or reserve again.
 if exists(select 1 from public.people_finance_combined_batches where id=p_operation) then
  return public.people_finance_issue_many(p_company,p_requests,p_actor,p_operation,p_bank,p_value_date,p_expected);
 end if;
 for request_id in select x from unnest(p_requests) x order by x loop
  select * into r from public.people_finance_requests where company_id=p_company and id=request_id for update;
  if r.id is null then raise exception 'A payroll submission is unavailable.'; end if;
  perform public.payment_release_actor(p_company,p_actor,r.station_id);
  select s.station_code into station_code from public.stations s where s.company_id=p_company and s.id=r.station_id;
  preview:=public.people_finance_payment_preview(p_company,r.run_id,r.station_id);
  expected:=p_expected->request_id::text;
  if expected is null or (expected->>'version')::int is distinct from r.version
    or expected->>'hash' is distinct from preview->>'hash'
    or expected->>'amountPaise' is distinct from preview->>'amountPaise'
    or expected->>'readyCount' is distinct from preview->>'readyCount'
  then raise exception '%: figures changed. Refresh and review the selection again.',station_code; end if;
  if (preview->>'changed')::boolean or not (preview->>'runApproved')::boolean
  then raise exception '%: People must approve and resubmit the current payroll.',station_code; end if;
  needs_override:=r.status='returned' or (r.status='submitted' and r.submitted_by=p_actor);
  if needs_override then
   if not public.people_finance_override_allowed(p_company,p_actor,r.station_id)
   then raise exception '%: a Managing Partner override or a fresh independent approval is required.',station_code; end if;
   if length(trim(coalesce(p_override_reason,''))) not between 10 and 2000
   then raise exception '%: record why the Managing Partner is overriding the prior return or self-approval restriction (10–2000 characters).',station_code; end if;
   select to_char(period_start,'YYYY-MM') into salary_month from public.hr_payroll_runs where company_id=p_company and id=r.run_id;
   perform public.assert_loss_payment_release(p_company,r.station_id,salary_month,'people:'||r.run_id);
   update public.people_finance_requests set status='approved',reviewed_by=p_actor,reviewed_at=clock_timestamp(),
    review_note=trim(p_override_reason),version=version+1 where id=r.id;
   insert into public.people_finance_events(request_id,company_id,actor_id,action,reason,snapshot)
    values(r.id,p_company,p_actor,'override_approve',trim(p_override_reason),jsonb_build_object('previous',to_jsonb(r),'operationId',p_operation,
     'selfApproval',r.submitted_by=p_actor,'reversedReturn',r.status='returned','payroll_hash',r.payroll_hash));
   updated_expected:=jsonb_set(updated_expected,array[request_id::text,'version'],to_jsonb(r.version+1));
  elsif r.status='submitted' then
   perform public.people_finance_decide(p_company,r.id,p_actor,r.version,'approve','Payroll reviewed and approved with combined bank download.');
   updated_expected:=jsonb_set(updated_expected,array[request_id::text,'version'],to_jsonb(r.version+1));
  end if;
 end loop;
 -- Any failed location rolls back every approval and every instruction in this call.
 return public.people_finance_issue_many(p_company,p_requests,p_actor,p_operation,p_bank,p_value_date,updated_expected);
end $$;
revoke all on function public.people_finance_approve_and_issue(uuid,uuid[],uuid,uuid,uuid,date,jsonb,text) from public,anon,authenticated;
grant execute on function public.people_finance_approve_and_issue(uuid,uuid[],uuid,uuid,uuid,date,jsonb,text) to service_role;
