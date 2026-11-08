-- Reuse the existing financial allocation ledger. Daily mode expands visibility;
-- training and the exception queue retain their existing fixed-pay scope.
create or replace function public.daily_id_has_payment_terms(p_company uuid,p_worker uuid,p_station uuid,p_date date)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.workforce w join public.designations d on d.id=w.designation_id and d.company_id=w.company_id
 where w.id=p_worker and w.company_id=p_company and d.code in('DA','DCD','ODCD','WM') and (
 exists(select 1 from public.field_executive_provider_mappings m join public.payment_method_components c on c.payment_method_id=m.payment_method_id and c.is_active
 where m.company_id=p_company and m.station_id=p_station and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w.id,w.source_profile_id)
 and m.status in('active','closed') and p_date between m.effective_from and coalesce(m.effective_to,p_date)
 and nullif(m.payment_values->>c.component_code,'')::numeric>=0)
 or exists(select 1 from public.workforce_payment_allocations a where a.company_id=p_company and a.workforce_id=p_worker and a.station_id=p_station
 and a.status in('active','closed') and p_date between a.effective_from and coalesce(a.effective_to,p_date) and jsonb_array_length(a.payment_components)>0)));
$$;

-- Company-wide identity checking prevents a different payment station bypassing
-- a paid/processing ad hoc lock. No historical payment is rewritten here.
create or replace function public.daily_id_usage_locks(p_company uuid,p_from date,p_to date)
returns table(workforce_id uuid,from_date date,to_date date,reason text) language sql stable set search_path='' as $$
 select i.workforce_id,i.period_start,i.period_end,'Bank payment '||i.status
 from public.workforce_payout_payment_items i where i.company_id=p_company and i.status in('processing','paid')
 and i.period_start<=p_to and i.period_end>=p_from
 union
 select a.credited_workforce_id,a.period_start,a.period_end,'Finalized payroll payment'
 from public.workforce_payout_effective_paid_allocations a where a.company_id=p_company and a.period_start<=p_to and a.period_end>=p_from
 union
 select i.workforce_id,r.period_start,r.period_end,'Payroll '||r.status
 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id
 where r.company_id=p_company and r.status in('approved','paid') and i.status<>'excluded' and r.period_start<=p_to and r.period_end>=p_from
 union
 select w.id,coalesce(p.delivery_work_date,p.adhoc_work_date),coalesce(p.delivery_work_date,p.adhoc_work_date),'Ad hoc '||p.status||' · '||p.request_no
 from public.payment_requests p join public.workforce w on w.company_id=p.company_id and (
 w.id in(p.adhoc_workforce_id,p.delivery_performer_workforce_id) or exists (
 select 1 from public.field_executive_provider_mappings m join public.providers pr on pr.id=m.provider_id
 where m.company_id=p.company_id and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w.id,w.source_profile_id)
 and m.status in('active','closed') and coalesce(p.delivery_work_date,p.adhoc_work_date) between m.effective_from and coalesce(m.effective_to,coalesce(p.delivery_work_date,p.adhoc_work_date))
 and upper(btrim(m.provider_member_id))=upper(btrim(coalesce(p.delivery_provider_employee_id,p.adhoc_provider_employee_id)))
 and upper(pr.code||' '||pr.name) like '%'||upper(p.adhoc_client)||'%'))
 where p.company_id=p_company and p.status in('processing','processed','paid')
 and coalesce(p.delivery_work_date,p.adhoc_work_date) between p_from and p_to;
$$;

create or replace function public.save_daily_id_usage_batch(p_company uuid,p_actor uuid,p_entries jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb; prior text;
begin
 prior:=current_setting('app.daily_id_usage',true);
 perform set_config('app.daily_id_usage','on',true);
 result:=public.save_workforce_worked_id_batch(p_company,p_actor,p_entries);
 perform set_config('app.daily_id_usage',coalesce(prior,''),true);
 return result;
exception when others then
 perform set_config('app.daily_id_usage',coalesce(prior,''),true);
 raise;
end $$;

CREATE OR REPLACE FUNCTION public.save_workforce_worked_id_review_base(p_company uuid, p_actor uuid, p_worker uuid, p_station uuid, p_date date, p_decision text, p_reason text, p_expected_version integer, p_shares jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old public.workforce_worked_id_reviews; rec public.workforce_worked_id_reviews; w public.workforce;
 s public.cps_shipment_daily; m public.field_executive_provider_mappings; target_mapping uuid; owners uuid[];
 item jsonb; q jsonb; counts jsonb; consumed numeric; n numeric; f text; v_station_code text; before_json jsonb; affected uuid[]; x uuid;
begin
 if p_company is null or p_worker is null or p_station is null or p_date is null or p_decision is null or p_reason is null or p_expected_version is null or p_shares is null or p_actor is null or p_decision not in ('worked','not_worked','other_work','reopened') or length(btrim(p_reason)) not between 3 and 2000
   or p_date > (now() at time zone 'Asia/Kolkata')::date or jsonb_typeof(p_shares)<>'array' or jsonb_array_length(p_shares)>10 then raise exception 'Choose a valid date, decision and reason (3–2000 characters).'; end if;
 perform public.lock_workforce_payment_allocation_company(p_company);
 select * into w from public.workforce where id=p_worker and company_id=p_company for update;
 if w.id is null or w.deleted_at is not null or p_date<coalesce(w.date_of_join,p_date) or p_date>coalesce(w.last_working_date,p_date) then raise exception 'Associate is not eligible on this work date.'; end if;
 select st.station_code into v_station_code from public.stations st where st.id=p_station and st.company_id=p_company;
 if v_station_code is null then raise exception 'Invalid location.'; end if;
 select * into old from public.workforce_worked_id_reviews where company_id=p_company and workforce_id=p_worker and work_date=p_date for update;
 if coalesce(old.version,0)<>p_expected_version then raise exception 'Another reviewer changed this day. Reload before saving.'; end if;
 if old.id is not null and old.station_id<>p_station then raise exception 'This day was reviewed at another station. Open that station to amend the review.';end if;
 affected:=array[p_worker];
 if old.id is not null then
   select to_jsonb(old)||jsonb_build_object('shares',coalesce(jsonb_agg(to_jsonb(a)) filter(where a.id is not null),'[]')) into before_json from public.workforce_worked_id_shares a where a.review_id=old.id;
   affected:=affected||array(select owner_workforce_id from public.workforce_worked_id_shares where review_id=old.id);
 end if;
 foreach x in array affected loop perform public.worked_id_check_open(p_company,x,p_date);
 if exists(select 1 from public.daily_id_usage_locks(p_company,p_date,p_date) l where l.workforce_id=x) then raise exception 'This associate/date has an ad hoc or finalized payment. Finance must reconcile it before changing daily ID usage.';end if;
 end loop;
 if p_decision<>'reopened' and not (p_decision='worked' and coalesce(current_setting('app.daily_id_usage',true),'')='on') and not exists(select 1 from public.attendance_punches a where a.company_id=p_company and a.source='biometric' and a.location_id=p_station and a.punch_date=p_date
    and (a.account_id in(w.id,w.source_profile_id) or a.field_executive_id in(w.id,w.source_profile_id) or a.employee_id in(w.id,w.source_profile_id) or a.contractor_id in(w.id,w.source_profile_id))) then raise exception 'No linked biometric punch exists on this date. Resolve biometric identity first.'; end if;
 if p_decision='not_worked' and (exists(select 1 from public.workforce_payout_attendance_values a where a.company_id=p_company and a.workforce_id=p_worker and p_date between a.effective_from and a.effective_to)
   or exists(select 1 from public.workforce_payout_attendance_overrides a where a.company_id=p_company and a.workforce_id=p_worker and a.work_date=p_date)) then raise exception 'This date has imported attendance. Correct or remove that attendance input before marking not worked.'; end if;
 if p_decision='worked' and jsonb_array_length(p_shares)=0 then raise exception 'Select at least one worked provider ID.'; end if;
 if (p_decision='not_worked' or (p_decision='worked' and current_setting('app.daily_id_usage',true) is distinct from 'on')) and exists(
  select 1 from public.cps_shipment_daily d join public.field_executive_provider_mappings pm
  on pm.company_id=d.company_id and upper(btrim(pm.provider_member_id))=upper(btrim(d.provider_employee_id))
  join public.providers pr on pr.id=pm.provider_id
  where d.company_id=p_company and d.work_date=p_date and coalesce(d.total_delivery,0)>0
  and coalesce(pm.workforce_id,pm.contractor_id,pm.employee_id,pm.field_executive_id) in(w.id,w.source_profile_id)
  and pm.status in('active','closed') and p_date between pm.effective_from and coalesce(pm.effective_to,p_date)
  and upper(pr.code||' '||pr.name) like '%'||upper(d.client)||'%'
 ) then raise exception 'Deliveries already exist under this associate’s own mapped ID. Resolve that evidence before using this no-delivery review.';end if;
 if p_decision<>'worked' and jsonb_array_length(p_shares)>0 then raise exception 'Only worked-ID decisions may contain delivery shares.'; end if;
 insert into public.workforce_worked_id_reviews(company_id,workforce_id,station_id,work_date,decision,reason,updated_by)
 values(p_company,p_worker,p_station,p_date,p_decision,btrim(p_reason),p_actor)
 on conflict(company_id,workforce_id,work_date) do update set station_id=excluded.station_id,decision=excluded.decision,reason=excluded.reason,
 version=workforce_worked_id_reviews.version+1,updated_by=p_actor,updated_at=now() returning * into rec;
 delete from public.workforce_worked_id_shares where review_id=rec.id;
 for item in select value from jsonb_array_elements(p_shares) loop
   select * into s from public.cps_shipment_daily where id=(item->>'source_shipment_id')::uuid and company_id=p_company and work_date=p_date and cps_shipment_daily.station_code=v_station_code for update;
   if s.id is null then raise exception 'The selected ID/date is outside this station or no longer exists.'; end if;
   select array_agg(distinct w2.id) into owners from public.field_executive_provider_mappings pm join public.providers pr on pr.id=pm.provider_id
    join public.workforce w2 on w2.company_id=pm.company_id and coalesce(pm.workforce_id,pm.contractor_id,pm.employee_id,pm.field_executive_id) in(w2.id,w2.source_profile_id)
    where pm.company_id=p_company and pm.station_id=p_station and upper(btrim(pm.provider_member_id))=upper(btrim(s.provider_employee_id))
    and pm.status in('active','closed') and p_date between pm.effective_from and coalesce(pm.effective_to,p_date)
    and upper(pr.code||' '||pr.name) like '%'||upper(s.client)||'%';
   if coalesce(cardinality(owners),0)<>1 or owners[1]=p_worker then raise exception 'The selected ID must have one other mapped associate on this work date.'; end if;
   perform public.worked_id_check_open(p_company,owners[1],p_date);
   if exists(select 1 from public.daily_id_usage_locks(p_company,p_date,p_date) l where l.workforce_id=owners[1]) then raise exception 'The ID owner has an ad hoc or finalized payment for this date. Finance must reconcile it before changing daily ID usage.';end if;affected:=affected||owners;
   if exists(select 1 from public.workforce_custom_production_inputs i where i.company_id=p_company and i.work_date=p_date and i.workforce_id in(p_worker,owners[1])) then raise exception 'A manual production input exists for this day. Resolve it before splitting provider work.'; end if;
   if exists(select 1 from public.payment_requests p where p.company_id=p_company and p.status in('processing','processed','paid') and
    ((p.adhoc_work_date=p_date and upper(p.adhoc_provider_employee_id)=upper(s.provider_employee_id) and p.location_id=p_station)
      or (p.delivery_work_date=p_date and p.delivery_identity_confirmed and p.delivery_performer_workforce_id in(p_worker,owners[1])))) then raise exception 'An ad hoc payment already covers this work. Finance must reconcile it before splitting.'; end if;
   if exists(select 1 from public.workforce_worked_id_shares a join public.workforce_worked_id_reviews r on r.id=a.review_id where a.source_shipment_id=s.id and r.decision='worked' and (a.owner_worked is distinct from (item->>'owner_worked')::boolean or a.source_counts is distinct from public.worked_id_counts(to_jsonb(s)))) then raise exception 'Another review has a different owner-worked answer or source counts. Reopen the related review first.';end if;
   if not exists(select 1 from public.field_executive_provider_mappings pm join public.payment_method_components c on c.payment_method_id=pm.payment_method_id and c.is_active where pm.company_id=p_company and pm.station_id=p_station and upper(btrim(pm.provider_member_id))=upper(btrim(s.provider_employee_id)) and pm.status in('active','closed') and p_date between pm.effective_from and coalesce(pm.effective_to,p_date)) then raise exception 'Configure the mapped owner payment method before splitting this ID.';end if;
   counts:=public.worked_id_counts(to_jsonb(s));
   if item->'source_counts' is distinct from counts then raise exception 'The delivery report changed. Reload the latest counts before saving.'; end if;
   if jsonb_typeof(item->'owner_worked') is distinct from 'boolean' then raise exception 'Confirm whether the mapped associate also worked.'; end if;
   q:=public.worked_id_counts(item->'quantities');
   if (q->>'total_delivery')::numeric<=0 then raise exception 'Enter the number of deliveries performed by this associate.'; end if;
   foreach f in array array['amazon_delivery','swa_delivery','total_delivery','c_return','mfn','mfn_return','assigned_count','delivery_assigned_count','pickup_assigned_count'] loop
    n:=(q->>f)::numeric;if n<0 or n<>trunc(n) then raise exception 'Shipment counts must be whole non-negative numbers.';end if;
    select coalesce(sum((a.quantities->>f)::numeric),0) into consumed from public.workforce_worked_id_shares a join public.workforce_worked_id_reviews r on r.id=a.review_id where a.source_shipment_id=s.id and r.decision='worked';
    if n+consumed>(counts->>f)::numeric then raise exception 'Assigned % exceeds the remaining report count.',f;end if;
    if not (item->>'owner_worked')::boolean and n+consumed<>(counts->>f)::numeric then raise exception 'If the mapped associate did not work, allocate all remaining % or confirm a shared day.',f;end if;
   end loop;
   if (counts->>'amazon_delivery')::numeric+(counts->>'swa_delivery')::numeric=(counts->>'total_delivery')::numeric
     and (q->>'amazon_delivery')::numeric+(q->>'swa_delivery')::numeric<>(q->>'total_delivery')::numeric then raise exception 'Amazon plus SWA deliveries must equal the delivery share.';end if;
   select pm.* into m from public.field_executive_provider_mappings pm join public.providers pr on pr.id=pm.provider_id
    where pm.company_id=p_company and pm.station_id=p_station and coalesce(pm.workforce_id,pm.contractor_id,pm.employee_id,pm.field_executive_id) in(w.id,w.source_profile_id)
    and pm.status in('active','closed') and p_date between pm.effective_from and coalesce(pm.effective_to,p_date) and upper(pr.code||' '||pr.name) like '%'||upper(s.client)||'%'
    order by pm.effective_from desc,pm.id desc limit 1;
   target_mapping:=m.id;
   if current_setting('app.daily_id_usage',true) is distinct from 'on' and target_mapping is not null and not exists(select 1 from public.payment_method_components c where c.payment_method_id=m.payment_method_id and c.is_active and c.component_type='amount' and c.pay_schedule in('per_day','per_month','per_hour')) then raise exception 'This review is for associates with existing fixed payment terms. Configure their own fixed pay first.';end if;
   if target_mapping is null and not exists(select 1 from public.workforce_payment_allocations a where a.company_id=p_company and a.workforce_id=p_worker and a.station_id=p_station and a.status in('active','closed') and p_date between a.effective_from and coalesce(a.effective_to,p_date)) then raise exception 'Configure this associate’s own payment terms first. Borrowing an ID must not borrow another person’s rate.';end if;
   insert into public.workforce_worked_id_shares(review_id,company_id,source_shipment_id,owner_workforce_id,recipient_mapping_id,owner_worked,quantities,source_counts)
    values(rec.id,p_company,s.id,owners[1],target_mapping,(item->>'owner_worked')::boolean,q,counts);
 end loop;
 perform public.workforce_bump_payout_period_dependency_revision(p_company,p_date);
 for x in select distinct unnest(affected) loop
   perform public.refresh_worked_id_month(p_company,x,p_date,p_actor);
 end loop;
 insert into public.workforce_worked_id_events(company_id,review_id,actor_id,before_state,after_state)
 select p_company,rec.id,p_actor,before_json,to_jsonb(rec)||jsonb_build_object('shares',coalesce(jsonb_agg(to_jsonb(a)) filter(where a.id is not null),'[]')) from public.workforce_worked_id_shares a where a.review_id=rec.id;
 return to_jsonb(rec)||jsonb_build_object('affected_workforce_ids',affected);
end $function$;;

CREATE OR REPLACE FUNCTION public.save_workforce_worked_id_review(p_company uuid, p_actor uuid, p_worker uuid, p_station uuid, p_date date, p_decision text, p_reason text, p_expected_version integer, p_shares jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result jsonb; x uuid; t public.workforce_buddy_training_requests; before_json jsonb;
begin
 perform public.lock_workforce_payment_allocation_company(p_company);
 if p_decision<>'reopened' and not (public.worked_id_fixed_delivery_day(p_company,p_worker,p_station,p_date) or (coalesce(current_setting('app.daily_id_usage',true),'')='on' and public.daily_id_has_payment_terms(p_company,p_worker,p_station,p_date))) then raise exception 'Only DA, DCD, ODCD or Wish Master with a positive fixed salary/MG component on this date can be reviewed here.';end if;
 if p_decision not in ('worked','not_worked','reopened') then raise exception 'Choose worked using another ID or not worked. Training needs separate approval.';end if;
 if exists(select 1 from jsonb_array_elements(p_shares) s where s->>'owner_worked'='false') and current_setting('app.worked_id_owner_absence',true) is distinct from 'confirmed' then raise exception 'Reload Worked ID review and explicitly confirm that the ID owner did not work before changing their attendance pay.';end if;
 select * into t from public.workforce_buddy_training_requests where company_id=p_company and workforce_id=p_worker and work_date=p_date for update;
 if t.id is not null and p_decision='reopened' then raise exception 'A training request cannot be reopened into paid attendance. Confirm actual worked ID or mark not worked.';end if;
 result:=public.save_workforce_worked_id_review_base(p_company,p_actor,p_worker,p_station,p_date,p_decision,p_reason,p_expected_version,p_shares);
 for x in select value::uuid from jsonb_array_elements_text(result->'affected_workforce_ids') loop
  perform public.worked_id_validate_absent_owner(p_company,x,p_date);
 end loop;
 if t.id is not null and t.status in('pending','approved') then
  before_json:=to_jsonb(t);
  update public.workforce_buddy_training_requests set status='cancelled',decided_by=p_actor,decided_at=now(),decision_note=p_reason,review_version=(result->>'version')::integer where id=t.id returning * into t;
  insert into public.workforce_buddy_training_events(company_id,request_id,actor_id,action,before_state,after_state) values(p_company,t.id,p_actor,'replace_review',before_json,to_jsonb(t));
 end if;
 return result;
end $function$;

revoke all on function public.daily_id_has_payment_terms(uuid,uuid,uuid,date), public.daily_id_usage_locks(uuid,date,date), public.save_daily_id_usage_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.daily_id_has_payment_terms(uuid,uuid,uuid,date), public.daily_id_usage_locks(uuid,date,date), public.save_daily_id_usage_batch(uuid,uuid,jsonb) to service_role;

-- Validate the exact transaction, including both owners' locks and all days,
-- then roll back the subtransaction. No review, event or refresh job persists.
create or replace function public.validate_daily_id_usage_batch(p_company uuid,p_actor uuid,p_entries jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 begin
  result:=public.save_daily_id_usage_batch(p_company,p_actor,p_entries);
  raise exception using errcode='PDA01',message='Daily usage validation rollback';
 exception when sqlstate 'PDA01' then return result;
 end;
end $$;
revoke all on function public.validate_daily_id_usage_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.validate_daily_id_usage_batch(uuid,uuid,jsonb) to service_role;

create or replace function public.guard_worked_id_adhoc_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status not in('processing','processed','paid') or (new.adhoc_work_date is null and new.delivery_work_date is null) then return new;end if;
 if tg_op='UPDATE' and new.status=old.status then return new;end if;
 perform public.lock_workforce_payment_allocation_company(new.company_id);
 if exists(select 1 from public.workforce_worked_id_reviews r join public.workforce_worked_id_shares a on a.review_id=r.id
 join public.cps_shipment_daily d on d.id=a.source_shipment_id where r.company_id=new.company_id and r.decision='worked'
 and r.work_date=coalesce(new.delivery_work_date,new.adhoc_work_date)
 and (new.adhoc_workforce_id in(r.workforce_id,a.owner_workforce_id)
 or new.delivery_performer_workforce_id in(r.workforce_id,a.owner_workforce_id)
 or (upper(btrim(coalesce(new.delivery_provider_employee_id,new.adhoc_provider_employee_id)))=upper(btrim(d.provider_employee_id))
 and upper(coalesce(new.adhoc_client,''))=upper(d.client))))
 then raise exception 'This day is already allocated through Worked ID review. Finance must reconcile the review before paying it again as ad hoc work.';end if;
 return new;
end $$;
revoke all on function public.guard_worked_id_adhoc_payment() from public,anon,authenticated;
