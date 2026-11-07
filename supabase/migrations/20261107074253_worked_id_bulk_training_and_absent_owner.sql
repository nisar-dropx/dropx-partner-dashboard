-- Every bulk save is one transaction. Training is a separately approved exception.
alter table public.workforce_worked_id_shares add column if not exists owner_absence_confirmed boolean not null default false;
create or replace function public.worked_id_capture_owner_absence() returns trigger language plpgsql set search_path='' as $$
begin new.owner_absence_confirmed:=not new.owner_worked and coalesce(current_setting('app.worked_id_owner_absence',true)='confirmed',false);return new;end $$;
revoke all on function public.worked_id_capture_owner_absence() from public,anon,authenticated;
drop trigger if exists worked_id_capture_owner_absence on public.workforce_worked_id_shares;
create trigger worked_id_capture_owner_absence before insert or update of owner_worked on public.workforce_worked_id_shares for each row execute function public.worked_id_capture_owner_absence();
create or replace function public.worked_id_fixed_delivery_day(p_company uuid,p_worker uuid,p_station uuid,p_date date) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.workforce w join public.designations d on d.id=w.designation_id and d.company_id=w.company_id
 where w.id=p_worker and w.company_id=p_company and d.code in('DA','DCD','ODCD','WM') and (
 exists(select 1 from public.field_executive_provider_mappings m join public.payment_method_components c on c.payment_method_id=m.payment_method_id and c.is_active
  where m.company_id=p_company and m.station_id=p_station and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w.id,w.source_profile_id)
  and m.status in('active','closed') and p_date between m.effective_from and coalesce(m.effective_to,p_date) and c.component_type='amount'
  and c.component_code in('MG_PER_DAY','MG_PER_MONTH','FIXED_PAY_PER_DAY','FIXED_PAY_PER_MONTH') and coalesce(nullif(m.payment_values->>c.component_code,'')::numeric,0)>0)
 or exists(select 1 from public.workforce_payment_allocations a cross join lateral jsonb_array_elements(a.payment_components)c
  where a.company_id=p_company and a.workforce_id=p_worker and a.station_id=p_station and a.status in('active','closed') and p_date between a.effective_from and coalesce(a.effective_to,p_date)
  and coalesce(c->>'component_type',c->>'type')='amount' and coalesce((c->>'is_active')::boolean,(c->>'active')::boolean,true)
  and coalesce(c->>'component_code',c->>'code') in('MG_PER_DAY','MG_PER_MONTH','FIXED_PAY_PER_DAY','FIXED_PAY_PER_MONTH')
  and coalesce(nullif(a.payment_values->>coalesce(c->>'component_code',c->>'code'),'')::numeric,0)>0)));
$$;
revoke all on function public.worked_id_fixed_delivery_day(uuid,uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.worked_id_fixed_delivery_day(uuid,uuid,uuid,date) to service_role;
create table if not exists public.workforce_buddy_training_requests (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 workforce_id uuid not null references public.workforce(id), station_id uuid not null references public.stations(id),
 work_date date not null, buddy_source_id uuid not null references public.cps_shipment_daily(id),
 buddy_workforce_id uuid not null references public.workforce(id), registered_at timestamptz not null,
 status text not null check(status in ('pending','approved','rejected','cancelled')),
 requested_by uuid not null, requested_at timestamptz not null default now(), reason text not null,
 approver_ids uuid[] not null, approver_names text[] not null default '{}',
 decided_by uuid, decided_at timestamptz, decision_note text,
 review_version integer not null,
 unique(company_id,workforce_id,work_date)
);
create index if not exists workforce_buddy_training_pending_idx on public.workforce_buddy_training_requests(company_id,status,station_id);
create table if not exists public.workforce_buddy_training_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null,
 request_id uuid not null references public.workforce_buddy_training_requests(id), actor_id uuid not null,
 action text not null, before_state jsonb, after_state jsonb not null, created_at timestamptz not null default now()
);
alter table public.workforce_buddy_training_requests enable row level security;
alter table public.workforce_buddy_training_events enable row level security;
revoke all on public.workforce_buddy_training_requests,public.workforce_buddy_training_events from public,anon,authenticated;
grant select,insert,update on public.workforce_buddy_training_requests to service_role;
grant select,insert on public.workforce_buddy_training_events to service_role;

create or replace function public.worked_id_validate_absent_owner(p_company uuid,p_worker uuid,p_date date) returns void
language plpgsql set search_path='' as $$
declare w public.workforce;
begin
 if not exists(select 1 from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id
  where r.company_id=p_company and r.work_date=p_date and r.decision='worked' and s.owner_workforce_id=p_worker and not s.owner_worked and s.owner_absence_confirmed) then return;end if;
 select * into w from public.workforce where id=p_worker and company_id=p_company;
 if exists(select 1 from public.workforce_buddy_training_requests t where t.company_id=p_company and t.buddy_workforce_id=p_worker and t.work_date=p_date and t.status in('pending','approved')) then raise exception 'This person is the buddy for a training request on this date. Resolve that request before marking absent.';end if;
 if exists(select 1 from public.workforce_worked_id_reviews r where r.company_id=p_company and r.workforce_id=p_worker and r.work_date=p_date and r.decision in('worked','other_work'))
 or exists(select 1 from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id where r.company_id=p_company and r.work_date=p_date and r.decision='worked' and s.owner_workforce_id=p_worker and s.owner_worked)
 then raise exception 'The ID owner has another review confirming work on this day. Resolve that review before marking absent.';end if;
 if exists(select 1 from public.workforce_payout_attendance_values a where a.company_id=p_company and a.workforce_id=p_worker and p_date between a.effective_from and a.effective_to)
 or exists(select 1 from public.workforce_payout_attendance_overrides a where a.company_id=p_company and a.workforce_id=p_worker and a.work_date=p_date)
 then raise exception 'The ID owner has imported attendance. Resolve that input before marking absent.';end if;
 if exists(select 1 from public.cps_shipment_daily d where d.company_id=p_company and d.work_date=p_date
  and coalesce(d.total_delivery,0) > coalesce((select sum((s.quantities->>'total_delivery')::numeric) from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id where s.source_shipment_id=d.id and r.decision='worked'),0)
  and exists(select 1 from public.field_executive_provider_mappings m join public.providers p on p.id=m.provider_id
   where m.company_id=p_company and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w.id,w.source_profile_id)
   and m.status in('active','closed') and p_date between m.effective_from and coalesce(m.effective_to,p_date)
   and upper(btrim(m.provider_member_id))=upper(btrim(d.provider_employee_id)) and upper(p.code||' '||p.name) like '%'||upper(d.client)||'%'))
 then raise exception 'The ID owner still has deliveries on another ID or an unassigned report. Resolve all work for this day before marking absent.';end if;
end $$;

do $$ begin
 if to_regprocedure('public.save_workforce_worked_id_review_base(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb)') is null then
  alter function public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb) rename to save_workforce_worked_id_review_base;
 end if;
end $$;

create or replace function public.save_workforce_worked_id_review(p_company uuid,p_actor uuid,p_worker uuid,p_station uuid,p_date date,
 p_decision text,p_reason text,p_expected_version integer,p_shares jsonb default '[]') returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb; x uuid; t public.workforce_buddy_training_requests; before_json jsonb;
begin
 perform public.lock_workforce_payment_allocation_company(p_company);
 if p_decision<>'reopened' and not public.worked_id_fixed_delivery_day(p_company,p_worker,p_station,p_date) then raise exception 'Only DA, DCD, ODCD or Wish Master with a positive fixed salary/MG component on this date can be reviewed here.';end if;
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
end $$;

create or replace function public.worked_id_training_buddy(p_company uuid,p_worker uuid,p_station uuid,p_date date,p_source uuid) returns uuid
language plpgsql set search_path='' as $$
declare owners uuid[]; buddy public.workforce; w public.workforce; d public.cps_shipment_daily;
begin
 select * into w from public.workforce where id=p_worker and company_id=p_company;
 if not public.worked_id_fixed_delivery_day(p_company,p_worker,p_station,p_date) then raise exception 'Training is restricted to delivery associates with a fixed salary/MG component.';end if;
 if exists(select 1 from public.cps_shipment_daily s join public.field_executive_provider_mappings m on m.company_id=s.company_id and upper(btrim(m.provider_member_id))=upper(btrim(s.provider_employee_id)) join public.providers pr on pr.id=m.provider_id
  where s.company_id=p_company and s.work_date=p_date and s.total_delivery>0 and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w.id,w.source_profile_id)
  and m.status in('active','closed') and p_date between m.effective_from and coalesce(m.effective_to,p_date) and upper(pr.code||' '||pr.name) like '%'||upper(s.client)||'%') then raise exception 'Deliveries exist under the trainee’s own ID. Resolve that evidence before approving training.';end if;
 if w.id is null or nullif(btrim(w.dropx_id),'') is null or w.created_at is null
  or date_trunc('month',w.created_at at time zone 'Asia/Kolkata')::date<>date_trunc('month',p_date)::date
  or (w.created_at at time zone 'Asia/Kolkata')::date>p_date
 then raise exception 'Buddy training is only available in the DropX ID registration month, on or after registration.';end if;
 select d0.* into d from public.cps_shipment_daily d0 join public.stations st on st.id=p_station and st.company_id=p_company and st.station_code=d0.station_code
  where d0.id=p_source and d0.company_id=p_company and d0.work_date=p_date and d0.total_delivery>0;
 if d.id is null then raise exception 'Select a buddy with recorded deliveries at this station on this date.';end if;
 select array_agg(distinct w2.id) into owners from public.field_executive_provider_mappings m join public.providers pr on pr.id=m.provider_id
  join public.workforce w2 on w2.company_id=m.company_id and coalesce(m.workforce_id,m.contractor_id,m.employee_id,m.field_executive_id) in(w2.id,w2.source_profile_id)
  where m.company_id=p_company and m.station_id=p_station and m.status in('active','closed') and p_date between m.effective_from and coalesce(m.effective_to,p_date)
  and upper(btrim(m.provider_member_id))=upper(btrim(d.provider_employee_id)) and upper(pr.code||' '||pr.name) like '%'||upper(d.client)||'%';
 if coalesce(cardinality(owners),0)<>1 or owners[1]=p_worker then raise exception 'The buddy must be a different, uniquely mapped associate.';end if;
 select * into buddy from public.workforce where id=owners[1] and company_id=p_company;
 if not exists(select 1 from public.attendance_punches a where a.company_id=p_company and a.location_id=p_station and a.punch_date=p_date and a.source='biometric'
  and coalesce(a.account_id,a.field_executive_id,a.contractor_id,a.employee_id) in(buddy.id,buddy.source_profile_id))
 then raise exception 'The buddy has no biometric punch at this station on this date.';end if;
 if exists(select 1 from public.workforce_worked_id_reviews r where r.company_id=p_company and r.workforce_id=buddy.id and r.work_date=p_date and r.decision='not_worked')
 or exists(select 1 from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id where r.company_id=p_company and r.work_date=p_date and r.decision='worked' and s.owner_workforce_id=buddy.id and not s.owner_worked)
 then raise exception 'The buddy is marked not worked on this date.';end if;
 if coalesce((select sum((s.quantities->>'total_delivery')::numeric) from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id where s.source_shipment_id=d.id and r.decision='worked'),0)>=d.total_delivery
 then raise exception 'The selected buddy has no remaining delivered work on this ID.';end if;
 return buddy.id;
end $$;

create or replace function public.save_workforce_worked_id_batch(p_company uuid,p_actor uuid,p_entries jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare e jsonb; result jsonb; results jsonb:='[]'; worker uuid; station uuid; day date; decision text; note text; version integer;
 t public.workforce_buddy_training_requests; prior jsonb; buddy uuid; approvers uuid[]; registration timestamptz;
begin
 if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 31 then raise exception 'Select between 1 and 31 days.';end if;
 if (select count(distinct value->>'workerId') from jsonb_array_elements(p_entries))<>1
 or (select count(distinct left(value->>'date',7)) from jsonb_array_elements(p_entries))<>1
 or (select count(distinct value->>'date') from jsonb_array_elements(p_entries))<>jsonb_array_length(p_entries)
 then raise exception 'A bulk review must contain unique days for one associate in one month.';end if;
 perform public.lock_workforce_payment_allocation_company(p_company);
 for e in select value from jsonb_array_elements(p_entries) order by value->>'date' loop
  perform set_config('app.worked_id_owner_absence','confirmed',true);
  worker:=(e->>'workerId')::uuid;station:=(e->>'stationId')::uuid;day:=(e->>'date')::date;decision:=e->>'decision';note:=e->>'reason';version:=(e->>'version')::integer;
  if note is null or length(btrim(note)) not between 3 and 1800 then raise exception 'Add a review reason (3–1800 characters).';end if;
  if decision in ('worked','not_worked','reopened') then
   result:=public.save_workforce_worked_id_review(p_company,p_actor,worker,station,day,decision,note,version,coalesce(e->'shares','[]'));
  elsif decision in ('training','approve_training','reject_training') then
   select * into t from public.workforce_buddy_training_requests where company_id=p_company and workforce_id=worker and work_date=day for update;
   prior:=case when t.id is null then null else to_jsonb(t) end;
   if decision='training' then
    if t.status in('pending','approved') then raise exception 'A training request already exists for this day.';end if;
    if (select count(*) from public.workforce_buddy_training_requests where company_id=p_company and workforce_id=worker and status in('pending','approved'))>=2 then raise exception 'Two training days are already used or awaiting approval. No third day is allowed.';end if;
    select array_agg(value::uuid) into approvers from jsonb_array_elements_text(e->'approverIds');
    if coalesce(cardinality(approvers),0)=0 or p_actor=any(approvers) then raise exception 'A different Cluster Manager or AOM must be assigned before requesting training.';end if;
    buddy:=public.worked_id_training_buddy(p_company,worker,station,day,(e->>'buddySourceId')::uuid);
    select created_at into registration from public.workforce where id=worker and company_id=p_company;
    -- Pending training never leaves a payable biometric day behind.
    result:=public.save_workforce_worked_id_review_base(p_company,p_actor,worker,station,day,'not_worked','Training awaiting CM/AOM approval: '||note,version,'[]');
    insert into public.workforce_buddy_training_requests(company_id,workforce_id,station_id,work_date,buddy_source_id,buddy_workforce_id,registered_at,status,requested_by,reason,approver_ids,approver_names,review_version)
    values(p_company,worker,station,day,(e->>'buddySourceId')::uuid,buddy,registration,'pending',p_actor,note,approvers,array(select jsonb_array_elements_text(e->'approverNames')),(result->>'version')::integer)
    on conflict(company_id,workforce_id,work_date) do update set buddy_source_id=excluded.buddy_source_id,buddy_workforce_id=excluded.buddy_workforce_id,registered_at=excluded.registered_at,status='pending',requested_by=p_actor,requested_at=now(),reason=note,approver_ids=excluded.approver_ids,approver_names=excluded.approver_names,decided_by=null,decided_at=null,decision_note=null,review_version=excluded.review_version returning * into t;
   else
    if t.id is null or t.station_id<>station or t.status<>'pending' or t.review_version<>version then raise exception 'Training request changed. Reload before deciding.';end if;
    if p_actor=t.requested_by or not(p_actor=any(t.approver_ids)) then raise exception 'Only the assigned Cluster Manager or AOM can decide training, never the requester.';end if;
    if decision='approve_training' then
     if t.registered_at is distinct from (select created_at from public.workforce where id=worker and company_id=p_company) then raise exception 'DropX registration evidence changed. Submit a fresh request.';end if;
     buddy:=public.worked_id_training_buddy(p_company,worker,station,day,t.buddy_source_id);
     if buddy<>t.buddy_workforce_id then raise exception 'The buddy mapping changed. Submit a fresh request.';end if;
    end if;
    result:=public.save_workforce_worked_id_review_base(p_company,p_actor,worker,station,day,case when decision='approve_training' then 'other_work' else 'not_worked' end,'Buddy training '||case when decision='approve_training' then 'approved: ' else 'rejected: ' end||note,version,'[]');
    update public.workforce_buddy_training_requests set status=case when decision='approve_training' then 'approved' else 'rejected' end,decided_by=p_actor,decided_at=now(),decision_note=note,review_version=(result->>'version')::integer where id=t.id returning * into t;
   end if;
   perform public.worked_id_validate_absent_owner(p_company,worker,day);
   insert into public.workforce_buddy_training_events(company_id,request_id,actor_id,action,before_state,after_state) values(p_company,t.id,p_actor,decision,prior,to_jsonb(t));
  else raise exception 'Unknown review decision.';
  end if;
  results:=results||jsonb_build_array(result);
 end loop;
 return jsonb_build_object('reviews',results,'affected_workforce_ids',(select jsonb_agg(distinct x.value) from jsonb_array_elements(results) r cross join lateral jsonb_array_elements(r->'affected_workforce_ids') x));
end $$;

-- Prevent subsequent imports from invalidating an approved absence or training proof.
create or replace function public.guard_worked_id_decision_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare c uuid; d date; x uuid; v jsonb;
begin
 if tg_table_name='cps_shipment_daily' then
  c:=coalesce(new.company_id,old.company_id);d:=coalesce(new.work_date,old.work_date);
  if tg_op in('UPDATE','DELETE') and exists(select 1 from public.workforce_buddy_training_requests t where t.buddy_source_id=old.id and t.status in('pending','approved'))
   and (tg_op='DELETE' or (public.worked_id_counts(to_jsonb(new)),new.provider_employee_id,new.station_code,new.work_date,new.client) is distinct from (public.worked_id_counts(to_jsonb(old)),old.provider_employee_id,old.station_code,old.work_date,old.client))
  then raise exception 'This delivery report supports a training request. Resolve that request before replacing the evidence.';end if;
  if tg_op<>'DELETE' then
   for x in select distinct s.owner_workforce_id from public.workforce_worked_id_shares s join public.workforce_worked_id_reviews r on r.id=s.review_id where r.company_id=c and r.work_date=d and r.decision='worked' and not s.owner_worked loop
    perform public.worked_id_validate_absent_owner(c,x,d);
   end loop;
  end if;
 elsif tg_table_name='workforce' then
  if new.created_at is distinct from old.created_at and exists(select 1 from public.workforce_buddy_training_requests t where t.company_id=old.company_id and t.workforce_id=old.id and t.status in('pending','approved')) then raise exception 'Registration date is evidence for a training request and cannot be changed.';end if;
 elsif tg_table_name='attendance_punches' then
  if tg_op='DELETE' or (new.account_id,new.field_executive_id,new.contractor_id,new.employee_id,new.punch_date,new.location_id,new.source) is distinct from (old.account_id,old.field_executive_id,old.contractor_id,old.employee_id,old.punch_date,old.location_id,old.source) then
   if exists(select 1 from public.workforce_buddy_training_requests t join public.workforce w on w.company_id=t.company_id and w.id in(t.workforce_id,t.buddy_workforce_id)
    where t.company_id=old.company_id and t.station_id=old.location_id and t.work_date=old.punch_date and t.status in('pending','approved') and coalesce(old.account_id,old.field_executive_id,old.contractor_id,old.employee_id) in(w.id,w.source_profile_id))
   then raise exception 'This biometric punch supports a training request. Resolve the request before changing its evidence.';end if;
  end if;
 elsif tg_table_name in('workforce_payout_attendance_values','workforce_payout_attendance_overrides') then
  v:=to_jsonb(new);c:=new.company_id;
  for d in select distinct r.work_date from public.workforce_worked_id_reviews r join public.workforce_worked_id_shares s on s.review_id=r.id
   where r.company_id=c and s.owner_workforce_id=new.workforce_id and not s.owner_worked and r.decision='worked'
   and r.work_date between coalesce((v->>'work_date')::date,(v->>'effective_from')::date) and coalesce((v->>'work_date')::date,(v->>'effective_to')::date)
  loop perform public.worked_id_validate_absent_owner(c,new.workforce_id,d);end loop;
  if exists(select 1 from public.workforce_buddy_training_requests t where t.company_id=c and t.workforce_id=new.workforce_id and t.status in('pending','approved')
   and t.work_date between coalesce((v->>'work_date')::date,(v->>'effective_from')::date) and coalesce((v->>'work_date')::date,(v->>'effective_to')::date)) then raise exception 'This attendance input overlaps a training request. Resolve that request first.';end if;
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
revoke all on function public.guard_worked_id_decision_evidence() from public,anon,authenticated;
drop trigger if exists worked_id_decision_evidence on public.cps_shipment_daily;
create trigger worked_id_decision_evidence after insert or update or delete on public.cps_shipment_daily for each row execute function public.guard_worked_id_decision_evidence();
drop trigger if exists worked_id_registration_evidence on public.workforce;
create trigger worked_id_registration_evidence before update on public.workforce for each row execute function public.guard_worked_id_decision_evidence();
drop trigger if exists worked_id_training_punch_guard on public.attendance_punches;
create trigger worked_id_training_punch_guard before update or delete on public.attendance_punches for each row execute function public.guard_worked_id_decision_evidence();
drop trigger if exists worked_id_owner_attendance_guard on public.workforce_payout_attendance_values;
create trigger worked_id_owner_attendance_guard after insert or update on public.workforce_payout_attendance_values for each row execute function public.guard_worked_id_decision_evidence();
drop trigger if exists worked_id_owner_attendance_guard on public.workforce_payout_attendance_overrides;
create trigger worked_id_owner_attendance_guard after insert or update on public.workforce_payout_attendance_overrides for each row execute function public.guard_worked_id_decision_evidence();

revoke all on function public.worked_id_validate_absent_owner(uuid,uuid,date),public.worked_id_training_buddy(uuid,uuid,uuid,date,uuid),public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb),public.save_workforce_worked_id_review_base(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb),public.save_workforce_worked_id_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.worked_id_validate_absent_owner(uuid,uuid,date),public.worked_id_training_buddy(uuid,uuid,uuid,date,uuid),public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb),public.save_workforce_worked_id_review_base(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb),public.save_workforce_worked_id_batch(uuid,uuid,jsonb) to service_role;

-- Extend the financial attendance projection without changing raw punches.
do $$ declare definition text; begin
 select pg_get_viewdef('public.workforce_payout_attendance_facts'::regclass,true) into definition;
 -- Replace only its review relation; retain every source column and its type.
 definition:=regexp_replace(definition,'LEFT JOIN workforce_worked_id_reviews r ON [^;]+',
 'LEFT JOIN LATERAL (SELECT r0.id,r0.reason FROM public.workforce_worked_id_reviews r0 WHERE r0.company_id=a.company_id AND r0.work_date=a.punch_date AND ((r0.workforce_id=w.id AND r0.decision=''not_worked'') OR (r0.decision=''worked'' AND EXISTS(SELECT 1 FROM public.workforce_worked_id_shares s WHERE s.review_id=r0.id AND s.owner_workforce_id=w.id AND NOT s.owner_worked AND s.owner_absence_confirmed))) ORDER BY r0.updated_at DESC LIMIT 1) r ON true','i');
 if position('LATERAL' in definition)=0 then raise exception 'Attendance view shape changed; review the migration.';end if;
 execute 'create or replace view public.workforce_payout_attendance_facts with(security_invoker=true) as '||definition;
end $$;
