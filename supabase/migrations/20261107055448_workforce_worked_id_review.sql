-- Day-level execution evidence. Permanent ID ownership and raw punches/reports stay intact.
create table if not exists public.workforce_worked_id_reviews (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
 workforce_id uuid not null references public.workforce(id), station_id uuid not null references public.stations(id),
 work_date date not null, decision text not null check(decision in ('worked','not_worked','other_work','reopened')),
 reason text not null check(length(btrim(reason)) between 3 and 2000), version integer not null default 1,
 updated_by uuid not null, updated_at timestamptz not null default now(),
 unique(company_id,workforce_id,work_date)
);
create table if not exists public.workforce_worked_id_shares (
 id uuid primary key default gen_random_uuid(), review_id uuid not null references public.workforce_worked_id_reviews(id),
 company_id uuid not null references public.companies(id), source_shipment_id uuid not null references public.cps_shipment_daily(id),
 owner_workforce_id uuid not null references public.workforce(id), recipient_mapping_id uuid references public.field_executive_provider_mappings(id),
 owner_worked boolean not null, quantities jsonb not null, source_counts jsonb not null,
 unique(review_id,source_shipment_id)
);
create index if not exists workforce_worked_id_shares_source_idx on public.workforce_worked_id_shares(source_shipment_id);
create index if not exists workforce_worked_id_shares_owner_idx on public.workforce_worked_id_shares(owner_workforce_id);
create index if not exists workforce_worked_id_shares_recipient_mapping_idx on public.workforce_worked_id_shares(recipient_mapping_id);
create index if not exists workforce_worked_id_review_period_idx on public.workforce_worked_id_reviews(company_id,work_date,station_id);
create table if not exists public.workforce_worked_id_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null, review_id uuid not null references public.workforce_worked_id_reviews(id),
 actor_id uuid not null, created_at timestamptz not null default now(), before_state jsonb, after_state jsonb not null
);
alter table public.workforce_worked_id_reviews enable row level security;
alter table public.workforce_worked_id_shares enable row level security;
alter table public.workforce_worked_id_events enable row level security;
revoke all on public.workforce_worked_id_reviews,public.workforce_worked_id_shares,public.workforce_worked_id_events from public,anon,authenticated;
grant select,insert,update,delete on public.workforce_worked_id_reviews,public.workforce_worked_id_shares to service_role;
grant select,insert on public.workforce_worked_id_events to service_role;

create or replace function public.worked_id_counts(p jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('amazon_delivery',coalesce((p->>'amazon_delivery')::numeric,0),'swa_delivery',coalesce((p->>'swa_delivery')::numeric,0),
 'total_delivery',coalesce((p->>'total_delivery')::numeric,0),'c_return',coalesce((p->>'c_return')::numeric,0),'mfn',coalesce((p->>'mfn')::numeric,0),'mfn_return',coalesce((p->>'mfn_return')::numeric,0),'assigned_count',coalesce((p->>'assigned_count')::numeric,0),'delivery_assigned_count',coalesce((p->>'delivery_assigned_count')::numeric,0),'pickup_assigned_count',coalesce((p->>'pickup_assigned_count')::numeric,0));
$$;
create or replace function public.worked_id_check_open(p_company uuid,p_worker uuid,p_date date) returns void
language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.workforce_payout_payment_items i where i.company_id=p_company and i.workforce_id=p_worker
   and p_date between i.period_start and i.period_end and i.status in ('processing','paid'))
 or exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=p_company and a.credited_workforce_id=p_worker and p_date between a.period_start and a.period_end)
 or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
   where r.company_id=p_company and i.workforce_id=p_worker and r.status in ('approved','paid') and i.status<>'excluded' and p_date between r.period_start and r.period_end)
 then raise exception 'This date is already approved, paid or in a bank file. Finance must resolve that payout before changing worked IDs.'; end if;
end $$;

create or replace function public.save_workforce_worked_id_review(p_company uuid,p_actor uuid,p_worker uuid,p_station uuid,p_date date,
 p_decision text,p_reason text,p_expected_version integer,p_shares jsonb default '[]') returns jsonb
language plpgsql set search_path='' as $$
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
 foreach x in array affected loop perform public.worked_id_check_open(p_company,x,p_date); end loop;
 if p_decision<>'reopened' and not exists(select 1 from public.attendance_punches a where a.company_id=p_company and a.source='biometric' and a.location_id=p_station and a.punch_date=p_date
    and (a.account_id in(w.id,w.source_profile_id) or a.field_executive_id in(w.id,w.source_profile_id) or a.employee_id in(w.id,w.source_profile_id) or a.contractor_id in(w.id,w.source_profile_id))) then raise exception 'No linked biometric punch exists on this date. Resolve biometric identity first.'; end if;
 if p_decision='not_worked' and (exists(select 1 from public.workforce_payout_attendance_values a where a.company_id=p_company and a.workforce_id=p_worker and p_date between a.effective_from and a.effective_to)
   or exists(select 1 from public.workforce_payout_attendance_overrides a where a.company_id=p_company and a.workforce_id=p_worker and a.work_date=p_date)) then raise exception 'This date has imported attendance. Correct or remove that attendance input before marking not worked.'; end if;
 if p_decision='worked' and jsonb_array_length(p_shares)=0 then raise exception 'Select at least one worked provider ID.'; end if;
 if p_decision in('worked','not_worked') and exists(
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
   perform public.worked_id_check_open(p_company,owners[1],p_date);affected:=affected||owners;
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
   if target_mapping is not null and not exists(select 1 from public.payment_method_components c where c.payment_method_id=m.payment_method_id and c.is_active and c.component_type='amount' and c.pay_schedule in('per_day','per_month','per_hour')) then raise exception 'This review is for associates with existing fixed payment terms. Configure their own fixed pay first.';end if;
   if target_mapping is null and not exists(select 1 from public.workforce_payment_allocations a where a.company_id=p_company and a.workforce_id=p_worker and a.station_id=p_station and a.status in('active','closed') and p_date between a.effective_from and coalesce(a.effective_to,p_date)) then raise exception 'Configure this associate’s own payment terms first. Borrowing an ID must not borrow another person’s rate.';end if;
   insert into public.workforce_worked_id_shares(review_id,company_id,source_shipment_id,owner_workforce_id,recipient_mapping_id,owner_worked,quantities,source_counts)
    values(rec.id,p_company,s.id,owners[1],target_mapping,(item->>'owner_worked')::boolean,q,counts);
 end loop;
 perform public.workforce_bump_payout_period_dependency_revision(p_company,p_date);
 for x in select distinct unnest(affected) loop
   perform public.enqueue_workforce_payout_dependency_refresh(p_company,x,p_station,p_date,p_date,p_actor);
 end loop;
 insert into public.workforce_worked_id_events(company_id,review_id,actor_id,before_state,after_state)
 select p_company,rec.id,p_actor,before_json,to_jsonb(rec)||jsonb_build_object('shares',coalesce(jsonb_agg(to_jsonb(a)) filter(where a.id is not null),'[]')) from public.workforce_worked_id_shares a where a.review_id=rec.id;
 return to_jsonb(rec)||jsonb_build_object('affected_workforce_ids',affected);
end $$;

-- Reuse raw table row types, but expose adjustments only to the trusted payout readers.
create or replace function public.worked_id_remaining(p_value numeric,p_used numeric,p_current jsonb,p_expected jsonb) returns numeric
language plpgsql immutable set search_path='' as $$ begin
 if p_expected is not null and p_expected is distinct from p_current then raise exception 'A reviewed delivery report changed. Reopen Worked ID review before releasing payouts.';end if;
 if coalesce(p_used,0)>coalesce(p_value,0) then raise exception 'Worked ID shares exceed the delivery report. Review the split.';end if;
 return coalesce(p_value,0)-coalesce(p_used,0);end $$;

revoke all on function public.worked_id_counts(jsonb),public.worked_id_check_open(uuid,uuid,date),public.worked_id_remaining(numeric,numeric,jsonb,jsonb),public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.worked_id_counts(jsonb),public.worked_id_check_open(uuid,uuid,date),public.worked_id_remaining(numeric,numeric,jsonb,jsonb),public.save_workforce_worked_id_review(uuid,uuid,uuid,uuid,date,text,text,integer,jsonb) to service_role;
create or replace view public.workforce_payout_shipment_facts with (security_invoker=true) as
select s.id,
 s.company_id,
 s.source_batch_id,
 s.client,
 s.work_date,
 s.station_code,
 s.provider_employee_id,
 s.provider_employee_name,
 s.shipment_type,
 case when a.source_shipment_id is null then s.amazon_delivery else public.worked_id_remaining(s.amazon_delivery,a.amazon_delivery,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as amazon_delivery,
 case when a.source_shipment_id is null then s.swa_delivery else public.worked_id_remaining(s.swa_delivery,a.swa_delivery,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as swa_delivery,
 case when a.source_shipment_id is null then s.c_return else public.worked_id_remaining(s.c_return,a.c_return,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as c_return,
 case when a.source_shipment_id is null then s.mfn else public.worked_id_remaining(s.mfn,a.mfn,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as mfn,
 case when a.source_shipment_id is null then s.mfn_return else public.worked_id_remaining(s.mfn_return,a.mfn_return,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as mfn_return,
 case when a.source_shipment_id is null then s.total_delivery else public.worked_id_remaining(s.total_delivery,a.total_delivery,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as total_delivery,
 case when a.source_shipment_id is null then s.total_activity else public.worked_id_remaining(s.total_delivery,a.total_delivery,public.worked_id_counts(to_jsonb(s)),a.source_counts)+public.worked_id_remaining(s.c_return,a.c_return,public.worked_id_counts(to_jsonb(s)),a.source_counts)+public.worked_id_remaining(s.mfn,a.mfn,public.worked_id_counts(to_jsonb(s)),a.source_counts)+public.worked_id_remaining(s.mfn_return,a.mfn_return,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as total_activity,
 s.raw_row_count,
 s.created_at,
 s.updated_at,
 s.pay_type,
 s.dropx_emp_code,
 s.dropx_name,
 s.del_rate,
 s.c_return_rate,
 s.mfn_rate,
 s.mfn_return_rate,
 s.mg_salary,
 s.fuel_rate,
 s.variable_pay,
 s.mg_pay,
 s.fuel_pay,
 s.da_total_pay,
 s.mapping_status,
 s.mapped_at,
 case when a.source_shipment_id is null then s.assigned_count else public.worked_id_remaining(s.assigned_count,a.assigned_count,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as assigned_count,
 case when a.source_shipment_id is null then s.delivery_assigned_count else public.worked_id_remaining(s.delivery_assigned_count,a.delivery_assigned_count,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as delivery_assigned_count,
 case when a.source_shipment_id is null then s.pickup_assigned_count else public.worked_id_remaining(s.pickup_assigned_count,a.pickup_assigned_count,public.worked_id_counts(to_jsonb(s)),a.source_counts) end as pickup_assigned_count
from public.cps_shipment_daily s left join (
 select sh.source_shipment_id,sum((sh.quantities->>'amazon_delivery')::numeric) as amazon_delivery,sum((sh.quantities->>'swa_delivery')::numeric) as swa_delivery,sum((sh.quantities->>'total_delivery')::numeric) as total_delivery,sum((sh.quantities->>'c_return')::numeric) as c_return,sum((sh.quantities->>'mfn')::numeric) as mfn,sum((sh.quantities->>'mfn_return')::numeric) as mfn_return,sum((sh.quantities->>'assigned_count')::numeric) as assigned_count,sum((sh.quantities->>'delivery_assigned_count')::numeric) as delivery_assigned_count,sum((sh.quantities->>'pickup_assigned_count')::numeric) as pickup_assigned_count,min(sh.source_counts::text)::jsonb as source_counts
 from public.workforce_worked_id_shares sh join public.workforce_worked_id_reviews r on r.id=sh.review_id and r.decision='worked'
 group by sh.source_shipment_id
) a on a.source_shipment_id=s.id
union all
select a.id,
 s.company_id,
 s.source_batch_id,
 s.client,
 s.work_date,
 s.station_code,
 m.provider_member_id as provider_employee_id,
 w.full_name as provider_employee_name,
 s.shipment_type,
 (a.quantities->>'amazon_delivery')::numeric as amazon_delivery,
 (a.quantities->>'swa_delivery')::numeric as swa_delivery,
 (a.quantities->>'c_return')::numeric as c_return,
 (a.quantities->>'mfn')::numeric as mfn,
 (a.quantities->>'mfn_return')::numeric as mfn_return,
 (a.quantities->>'total_delivery')::numeric as total_delivery,
 ((a.quantities->>'total_delivery')::numeric+(a.quantities->>'c_return')::numeric+(a.quantities->>'mfn')::numeric+(a.quantities->>'mfn_return')::numeric) as total_activity,
 s.raw_row_count,
 s.created_at,
 s.updated_at,
 s.pay_type,
 w.dropx_id as dropx_emp_code,
 w.full_name as dropx_name,
 0::numeric as del_rate,
 0::numeric as c_return_rate,
 0::numeric as mfn_rate,
 0::numeric as mfn_return_rate,
 0::numeric as mg_salary,
 0::numeric as fuel_rate,
 0::numeric as variable_pay,
 0::numeric as mg_pay,
 0::numeric as fuel_pay,
 0::numeric as da_total_pay,
 s.mapping_status,
 s.mapped_at,
 (a.quantities->>'assigned_count')::numeric as assigned_count,
 (a.quantities->>'delivery_assigned_count')::numeric as delivery_assigned_count,
 (a.quantities->>'pickup_assigned_count')::numeric as pickup_assigned_count
from public.workforce_worked_id_shares a join public.workforce_worked_id_reviews r on r.id=a.review_id and r.decision='worked'
join public.cps_shipment_daily s on s.id=a.source_shipment_id
join public.field_executive_provider_mappings m on m.id=a.recipient_mapping_id
join public.workforce w on w.id=r.workforce_id;

create or replace view public.workforce_payout_attendance_facts with (security_invoker=true) as
select a.id,
 a.enrolment_id,
 a.employee_id,
 a.employee_code,
 a.station_code,
 a.punch_date,
 case when r.id is not null then null else a.in_time end as in_time,
 case when r.id is not null then null else a.out_time end as out_time,
 a.punch_count,
 case when r.id is not null then 0 else a.work_minutes end as work_minutes,
 case when r.id is not null then 'A' else a.status end as status,
 case when r.id is not null then 'Not worked: '||r.reason else a.remark end as remark,
 a.updated_at,
 a.company_id,
 a.worker_type,
 a.field_executive_id,
 a.location_id,
 a.worker_name,
 a.in_source,
 a.out_source,
 a.manual_in_request_id,
 a.manual_out_request_id,
 a.manual_in_approved_by,
 a.manual_out_approved_by,
 a.manual_in_approver_name,
 a.manual_out_approver_name,
 a.manual_in_approved_at,
 a.manual_out_approved_at,
 a.punch_in_location_id,
 a.punch_in_station_code,
 a.punch_out_location_id,
 a.punch_out_station_code,
 a.contractor_id,
 a.work_mode,
 a.wfh_request_id,
 a.workforce_id,
 a.business_trip_request_id,
 a.wfh_scheduled_start_at,
 a.wfh_scheduled_end_at,
 a.wfh_scheduled_minutes,
 a.wfh_credit_finalized_at
from public.attendance_daily a left join public.workforce w on w.company_id=a.company_id and coalesce(a.workforce_id,a.employee_id,a.contractor_id,a.field_executive_id) in(w.id,w.source_profile_id)
left join public.workforce_worked_id_reviews r on r.company_id=a.company_id and r.workforce_id=w.id and r.work_date=a.punch_date and r.decision='not_worked';
revoke all on public.workforce_payout_shipment_facts,public.workforce_payout_attendance_facts from public,anon,authenticated;
grant select on public.workforce_payout_shipment_facts,public.workforce_payout_attendance_facts to service_role;

-- Later imports/configuration edits must explicitly reopen the affected review.
-- SECURITY DEFINER is necessary: ordinary authenticated source-table writers do
-- not have access to this private review ledger.
create or replace function public.guard_worked_id_review_inputs() returns trigger
language plpgsql security definer set search_path='' as $$
declare v jsonb; prior jsonb; c uuid; d date; worker uuid;
begin
 v:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 prior:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
 c:=(v->>'company_id')::uuid;
 if tg_table_name='cps_shipment_daily' then
  if tg_op='UPDATE' and public.worked_id_counts(v)=public.worked_id_counts(prior)
   and (v->>'provider_employee_id',v->>'station_code',v->>'client',v->>'work_date') is not distinct from
       (prior->>'provider_employee_id',prior->>'station_code',prior->>'client',prior->>'work_date') then return new;end if;
  if exists(select 1 from public.workforce_worked_id_shares a join public.workforce_worked_id_reviews r on r.id=a.review_id
    where a.source_shipment_id=(v->>'id')::uuid and r.decision='worked') then
   raise exception 'This provider ID/day has a Worked ID review. Reopen its reviews before replacing delivery evidence.';end if;
 elsif tg_table_name='field_executive_provider_mappings' then
  -- Rates can change through the existing dated rate workflow; ID ownership cannot.
  if tg_op='UPDATE' and (v-'updated_at'-'payment_values'-'production_threshold_config')=(prior-'updated_at'-'payment_values'-'production_threshold_config') then return new;end if;
  perform public.lock_workforce_payment_allocation_company(c);
  if exists(select 1 from public.workforce_worked_id_shares a join public.workforce_worked_id_reviews r on r.id=a.review_id
    join public.workforce w on w.id=a.owner_workforce_id
    where r.company_id=c and r.decision='worked' and (a.recipient_mapping_id=(v->>'id')::uuid
    or (coalesce((prior->>'workforce_id')::uuid,(prior->>'contractor_id')::uuid,(prior->>'employee_id')::uuid,(prior->>'field_executive_id')::uuid) in(w.id,w.source_profile_id)
      and r.work_date between (prior->>'effective_from')::date and coalesce((prior->>'effective_to')::date,r.work_date)))) then
   raise exception 'This ID mapping supports a Worked ID review. Reopen the affected days before changing ownership or dates.';end if;
 else
  worker:=(v->>'workforce_id')::uuid; d:=(v->>'work_date')::date;
  perform public.lock_workforce_payment_allocation_company(c);
  if exists(select 1 from public.workforce_worked_id_reviews r where r.company_id=c
   and ((tg_table_name='workforce_custom_production_inputs' and r.decision='worked' and r.work_date=d and
     (r.workforce_id=worker or exists(select 1 from public.workforce_worked_id_shares a where a.review_id=r.id and a.owner_workforce_id=worker)))
    or (tg_table_name<>'workforce_custom_production_inputs' and r.decision='not_worked' and r.workforce_id=worker
       and r.work_date between coalesce(d,(v->>'effective_from')::date) and coalesce(d,(v->>'effective_to')::date)))) then
   raise exception 'This input conflicts with a Worked ID review. Reopen that day before importing replacement attendance or production.';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.guard_worked_id_review_inputs() from public,anon,authenticated;
drop trigger if exists worked_id_source_guard on public.cps_shipment_daily;
create trigger worked_id_source_guard before update or delete on public.cps_shipment_daily for each row execute function public.guard_worked_id_review_inputs();
drop trigger if exists worked_id_mapping_guard on public.field_executive_provider_mappings;
create trigger worked_id_mapping_guard before update or delete on public.field_executive_provider_mappings for each row execute function public.guard_worked_id_review_inputs();
drop trigger if exists worked_id_input_guard on public.workforce_payout_attendance_overrides;
create trigger worked_id_input_guard before insert or update on public.workforce_payout_attendance_overrides for each row execute function public.guard_worked_id_review_inputs();
drop trigger if exists worked_id_input_guard on public.workforce_payout_attendance_values;
create trigger worked_id_input_guard before insert or update on public.workforce_payout_attendance_values for each row execute function public.guard_worked_id_review_inputs();
drop trigger if exists worked_id_input_guard on public.workforce_custom_production_inputs;
create trigger worked_id_input_guard before insert or update on public.workforce_custom_production_inputs for each row execute function public.guard_worked_id_review_inputs();

create or replace function public.guard_worked_id_adhoc_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status not in('processing','processed','paid') or (new.adhoc_work_date is null and new.delivery_work_date is null) then return new;end if;
 if tg_op='UPDATE' and new.status=old.status then return new;end if;
 perform public.lock_workforce_payment_allocation_company(new.company_id);
 if exists(select 1 from public.workforce_worked_id_reviews r join public.workforce_worked_id_shares a on a.review_id=r.id
  join public.cps_shipment_daily d on d.id=a.source_shipment_id where r.company_id=new.company_id and r.decision='worked'
  and ((new.adhoc_work_date=r.work_date and new.location_id=r.station_id and upper(new.adhoc_provider_employee_id)=upper(d.provider_employee_id))
    or (new.delivery_work_date=r.work_date and new.delivery_identity_confirmed and new.delivery_performer_workforce_id in(r.workforce_id,a.owner_workforce_id)))) then
  raise exception 'This day is already allocated through Worked ID review. Finance must reconcile the review before paying it again as ad hoc work.';end if;
 return new;
end $$;
revoke all on function public.guard_worked_id_adhoc_payment() from public,anon,authenticated;
drop trigger if exists worked_id_adhoc_guard on public.payment_requests;
create trigger worked_id_adhoc_guard before insert or update on public.payment_requests for each row execute function public.guard_worked_id_adhoc_payment();

-- Costing and payroll consume the same financial projection. Preserve every
-- existing scoped source-facts rule and grant from the deployed function.
do $migration$
declare body text;
begin
 if to_regprocedure('public.ops_cps_source_facts(uuid,date,date,text[])') is not null then
  body:=pg_get_functiondef('public.ops_cps_source_facts(uuid,date,date,text[])'::regprocedure);
  body:=replace(replace(body,'public.cps_shipment_daily','public.workforce_payout_shipment_facts'),'public.attendance_daily','public.workforce_payout_attendance_facts');
  execute body;
 end if;
end $migration$;
