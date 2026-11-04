begin;
create table if not exists public.payment_adhoc_driver_rules (
 company_id uuid not null references public.companies(id), reason_key text not null,
 label text not null check(length(btrim(label)) between 1 and 80),
 designation_codes text[] not null default '{}', is_active boolean not null default true,
 sort_order integer not null default 0 check(sort_order between 0 and 100), updated_by uuid, updated_at timestamptz not null default now(),
 primary key(company_id,reason_key),
 check((reason_key='dcd_leave' and designation_codes=array['DCD','ODCD']) or (reason_key='driver_leave' and designation_codes=array['DR']) or (reason_key='vehicle_service' and designation_codes='{}'))
);
insert into public.payment_adhoc_driver_rules(company_id,reason_key,label,designation_codes,sort_order)
 select distinct h.company_id,r.* from public.payment_heads h cross join (values
 ('dcd_leave','DCD DA on leave',array['DCD','ODCD'],10),('driver_leave','Driver on leave',array['DR'],20),('vehicle_service','Vehicle service',array[]::text[],30)
 ) r(reason_key,label,designation_codes,sort_order) where h.code='ADHOC_DRIVER' on conflict do nothing;
create table if not exists public.payment_adhoc_driver_absences (
 request_id uuid primary key references public.payment_requests(id) on delete restrict deferrable initially deferred,
 company_id uuid not null references public.companies(id), workforce_id uuid not null,
 station_id uuid not null, work_date date not null, request_no text not null,
 attendance_id uuid, attendance_before jsonb, attendance_created boolean not null default false,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(company_id,workforce_id) references public.workforce(company_id,id),
 foreign key(company_id,station_id) references public.stations(company_id,id)
);
create unique index if not exists payment_driver_absent_day_unique on public.payment_adhoc_driver_absences(company_id,workforce_id,work_date) where active;
create index if not exists payment_driver_absence_period on public.payment_adhoc_driver_absences(company_id,work_date) where active;
create table if not exists public.payment_adhoc_driver_events (
 id bigint generated always as identity primary key, company_id uuid not null, request_id uuid, actor_id uuid,
 event text not null, before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);
alter table public.payment_adhoc_driver_rules enable row level security;
alter table public.payment_adhoc_driver_absences enable row level security;
alter table public.payment_adhoc_driver_events enable row level security;
revoke all on public.payment_adhoc_driver_rules,public.payment_adhoc_driver_absences,public.payment_adhoc_driver_events from public,anon,authenticated;
grant select,insert,update on public.payment_adhoc_driver_rules,public.payment_adhoc_driver_absences to service_role;
grant select,insert on public.payment_adhoc_driver_events to service_role;
grant usage,select on sequence public.payment_adhoc_driver_events_id_seq to service_role;

-- Preserve source attendance; release only the absence written by this request.
create or replace function public.sync_payment_driver_attendance()
returns trigger language plpgsql set search_path='' as $$
declare w public.workforce; a public.attendance_daily; marker text; station_code text; created boolean;
begin
 if tg_op='UPDATE' and new.active=old.active then return new; end if;
 marker:='Absent · replacement '||new.request_no;
 if not new.active then
  select * into a from public.attendance_daily where id=new.attendance_id and company_id=new.company_id for update;
  if found and a.status='A' and a.remark=marker and a.in_time is null and a.out_time is null and coalesce(a.punch_count,0)=0 then
   if new.attendance_created then delete from public.attendance_daily where id=a.id;
   else update public.attendance_daily set status=new.attendance_before->>'status',remark=new.attendance_before->>'remark',updated_at=now() where id=a.id; end if;
  end if;
  return new;
 end if;
 select * into w from public.workforce where company_id=new.company_id and id=new.workforce_id;
 select s.station_code into station_code from public.stations s where s.company_id=new.company_id and s.id=new.station_id;
 select * into a from public.attendance_daily d where d.company_id=new.company_id and d.punch_date=new.work_date
  and (d.workforce_id=w.id or d.enrolment_id=coalesce(nullif(w.biometric_id,''),w.dropx_id)) order by (d.workforce_id=w.id) desc nulls last limit 1 for update;
 created:=not found;
 if not created and (a.in_time is not null or a.out_time is not null or coalesce(a.punch_count,0)>0 or coalesce(a.work_minutes,0)>0) then raise exception 'Attendance changed; review recorded work before requesting a replacement.'; end if;
 update public.payment_adhoc_driver_absences set attendance_before=case when created then null else jsonb_build_object('status',a.status,'remark',a.remark) end,attendance_created=created where request_id=new.request_id;
 if created then
  insert into public.attendance_daily(company_id,enrolment_id,workforce_id,worker_type,worker_name,location_id,station_code,punch_date,status,remark,punch_count,work_minutes)
  values(new.company_id,coalesce(nullif(w.biometric_id,''),w.dropx_id),w.id,'individual_contract',w.full_name,new.station_id,station_code,new.work_date,'A',marker,0,0) returning * into a;
 else
  update public.attendance_daily set status='A',remark=marker,updated_at=now() where id=a.id;
 end if;
 update public.payment_adhoc_driver_absences set attendance_id=a.id where request_id=new.request_id;
 return new;
end;
$$;
-- Narrow trigger-only lookup must work for attendance writers without granting access to payment data.
-- Runs after existing leave policies. Punches and their source status are retained.
create or replace function public.payment_driver_attendance_status()
returns trigger language plpgsql security definer set search_path='' as $$
declare ref text;
begin
 select request_no into ref from public.payment_adhoc_driver_absences where company_id=new.company_id and workforce_id=new.workforce_id and work_date=new.punch_date and active;
 if ref is not null then
  if new.in_time is null and new.out_time is null and coalesce(new.punch_count,0)=0 then new.status:='A'; end if;
  new.remark:='Absent · replacement '||ref||case when new.in_time is not null or new.out_time is not null or coalesce(new.punch_count,0)>0 then ' · Punch conflict: review replacement request' else '' end;
 end if;
 return new;
end;
$$;
drop trigger if exists payment_driver_attendance_sync on public.payment_adhoc_driver_absences;
create trigger payment_driver_attendance_sync after insert or update of active on public.payment_adhoc_driver_absences for each row execute function public.sync_payment_driver_attendance();
drop trigger if exists zz_payment_driver_absence on public.attendance_daily;
create trigger zz_payment_driver_absence before insert or update on public.attendance_daily for each row execute function public.payment_driver_attendance_status();
revoke all on function public.sync_payment_driver_attendance(),public.payment_driver_attendance_status() from public,anon,authenticated;
grant execute on function public.sync_payment_driver_attendance(),public.payment_driver_attendance_status() to service_role;

create or replace function public.adhoc_driver_request_context(p_company uuid,p_station uuid,p_day date)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
 'reasons',coalesce((select jsonb_agg(to_jsonb(r) order by r.sort_order) from public.payment_adhoc_driver_rules r where r.company_id=p_company and r.is_active),'[]'::jsonb),
 'people',coalesce((select jsonb_agg(x order by x.full_name) from (
 select distinct w.id,w.full_name,w.dropx_id,d.code designation_code from public.workforce w join public.designations d on d.company_id=w.company_id and d.id=w.designation_id
 where w.company_id=p_company and w.deleted_at is null and w.is_active and coalesce(w.date_of_join,p_day)<=p_day and (w.last_working_date is null or w.last_working_date>=p_day)
 and d.code in ('DCD','ODCD','DR') and (w.location_id=p_station
 or exists(select 1 from public.workforce_payment_allocations a where a.company_id=p_company and a.workforce_id=w.id and a.station_id=p_station and a.status in ('active','closed') and a.effective_from<=p_day and (a.effective_to is null or a.effective_to>=p_day))
 or exists(select 1 from public.field_executive_provider_mappings m where m.company_id=p_company and (m.workforce_id=w.id or coalesce(m.contractor_id,m.employee_id,m.field_executive_id)=w.source_profile_id or m.field_executive_id=w.id) and m.station_id=p_station and m.status in ('active','closed') and m.effective_from<=p_day and (m.effective_to is null or m.effective_to>=p_day)))) x),'[]'::jsonb),
 'vehicles',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'vehicle_no',v.vehicle_no,'status',v.status) order by v.vehicle_no) from public.fleet_vehicles v join public.stations s on s.company_id=v.company_id and s.station_code=v.station_code
 where v.company_id=p_company and s.id=p_station and v.status in ('under_service','breakdown')),'[]'::jsonb));
$$;

create or replace function public.validate_adhoc_driver_request(p_company uuid,p_station_code text,p_details jsonb,p_request uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare r public.payment_adhoc_driver_rules; w public.workforce; v public.fleet_vehicles; station uuid; day date; person uuid; veh uuid; original jsonb; ctx jsonb;
begin
 select id into station from public.stations where company_id=p_company and station_code=p_station_code and is_active;
 if station is null then raise exception 'Select an active station.'; end if;
 select * into r from public.payment_adhoc_driver_rules where company_id=p_company and reason_key=p_details->>'reason_key' and is_active;
 if not found then raise exception 'Select an enabled Adhoc Driver sub-reason.'; end if;
 day:=nullif(p_details->>'work_date','')::date;
 if day is null then raise exception 'Select the deployment date.'; end if;
 select details->'adhoc_driver' into original from public.payment_requests where company_id=p_company and id=p_request;
 if day<>(now() at time zone 'Asia/Kolkata')::date and (original is null or original->>'work_date'<>day::text) then raise exception 'Use today for a new request; the original date may be kept on correction.'; end if;
 if r.reason_key='vehicle_service' then
  veh:=nullif(p_details->>'vehicle_id','')::uuid;
  select * into v from public.fleet_vehicles where company_id=p_company and id=veh and station_code=p_station_code and status in ('under_service','breakdown') for share;
  if not found then raise exception 'Select a station Fleet vehicle marked Under service or Breakdown.'; end if;
  return jsonb_build_object('reason_key',r.reason_key,'reason_label',r.label,'work_date',day,'vehicle_id',v.id,'vehicle_no',v.vehicle_no);
 end if;
 person:=nullif(p_details->>'workforce_id','')::uuid;
 ctx:=public.adhoc_driver_request_context(p_company,station,day);
 if not exists(select 1 from jsonb_array_elements(ctx->'people') p where p->>'id'=person::text and p->>'designation_code'=any(r.designation_codes)) then raise exception 'Select an eligible station-mapped person for this reason and date.'; end if;
 select * into w from public.workforce where company_id=p_company and id=person;
 if exists(select 1 from public.payment_adhoc_driver_absences a where a.company_id=p_company and a.workforce_id=person and a.work_date=day and a.active and a.request_id is distinct from p_request) then raise exception 'A replacement request already marks this person absent for this day.'; end if;
 if exists(select 1 from public.attendance_daily a where a.company_id=p_company and a.punch_date=day and (a.workforce_id=w.id or a.employee_id=w.source_profile_id or a.contractor_id=w.source_profile_id or a.field_executive_id=w.id or a.enrolment_id=coalesce(nullif(w.biometric_id,''),w.dropx_id)) and (a.in_time is not null or a.out_time is not null or a.work_minutes>0 or a.punch_count>0))
 or exists(select 1 from public.workforce_payout_attendance_overrides a where a.company_id=p_company and a.workforce_id=w.id and a.work_date=day and a.work_day_units>0)
 or exists(select 1 from public.workforce_payout_attendance_values a where a.company_id=p_company and a.workforce_id=w.id and day between a.effective_from and a.effective_to and a.quantity>0)
 then raise exception 'Attendance/work is already recorded for this person and day. Correct it through attendance review before requesting a replacement.'; end if;
 if exists(select 1 from public.cps_shipment_daily s join public.field_executive_provider_mappings m on m.company_id=s.company_id and upper(btrim(m.provider_member_id))=upper(btrim(s.provider_employee_id)) join public.stations st on st.company_id=m.company_id and st.id=m.station_id and st.station_code=s.station_code join public.providers pr on pr.id=m.provider_id and pr.company_id=m.company_id
 where s.company_id=p_company and s.work_date=day and (coalesce(s.total_activity,0)>0 or coalesce(s.total_delivery,0)>0 or coalesce(s.c_return,0)>0)
 and (lower(pr.code)=lower(s.client) or lower(pr.name)=lower(s.client)) and m.effective_from<=day and (m.effective_to is null or m.effective_to>=day) and m.status in ('active','closed') and (m.workforce_id=w.id or m.field_executive_id=w.id or coalesce(m.contractor_id,m.employee_id,m.field_executive_id)=w.source_profile_id)) then raise exception 'Provider work is recorded for this person and day. Review it before marking the person absent.'; end if;
 if exists(select 1 from public.workforce_payout_payment_items i where i.company_id=p_company and i.workforce_id=w.id and day between i.period_start and i.period_end and i.status not in ('cancelled','failed'))
 or exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=p_company and a.credited_workforce_id=w.id and day between a.period_start and a.period_end)
 or exists(select 1 from public.workforce_payroll_runs pr join public.workforce_payroll_items i on i.company_id=pr.company_id and i.payroll_run_id=pr.id where pr.company_id=p_company and i.workforce_id=w.id and pr.status in ('approved','paid') and i.status<>'excluded' and day between pr.period_start and pr.period_end)
 then raise exception 'This person has finalized or bank-issued payroll for the selected day. Finance must review it first.'; end if;
 return jsonb_build_object('reason_key',r.reason_key,'reason_label',r.label,'work_date',day,'workforce_id',w.id,'person_name',w.full_name,'dropx_id',w.dropx_id);
end;
$$;

create or replace function public.payment_adhoc_driver_guard()
returns trigger language plpgsql set search_path='' as $$
declare code text; d jsonb; prior jsonb; a public.payment_adhoc_driver_absences; target_active boolean; changed boolean; station uuid; location uuid;
begin
 if tg_op='DELETE' then
  if old.details ? 'adhoc_driver' then raise exception 'Cancel the replacement request to retain attendance and payroll history.'; end if;
  return old;
 end if;
 select h.code into code from public.payment_heads h where h.company_id=new.company_id and h.id=new.payment_head_id;
 d:=new.details->'adhoc_driver';
 if tg_op='UPDATE' then prior:=old.details->'adhoc_driver'; end if;
 if code<>'ADHOC_DRIVER' and d is null and prior is null then return new; end if;
 if prior is null and d is null then return new; end if; -- Backward-compatible rollout; new request actions require structured details.
 if code is distinct from 'ADHOC_DRIVER' or d is null then raise exception 'Adhoc Driver details cannot be removed or moved to another payment head.'; end if;
 perform public.lock_workforce_payment_allocation_company(new.company_id);
 changed:=tg_op='INSERT' or d is distinct from prior;
 if tg_op='UPDATE' and (new.company_id is distinct from old.company_id or new.location_id is distinct from old.location_id or new.location_code is distinct from old.location_code) then raise exception 'Replacement request station cannot be changed.'; end if;
 if changed then
  if tg_op='UPDATE' and old.status not in ('draft','returned','rejected') then raise exception 'Return the request for correction before changing its person, date or reason.'; end if;
  d:=public.validate_adhoc_driver_request(new.company_id,new.location_code,d,new.id);
  new.details:=jsonb_set(coalesce(new.details,'{}'),'{adhoc_driver}',d);
 end if;
 target_active:=new.status not in ('draft','rejected','cancelled');
 select * into a from public.payment_adhoc_driver_absences where request_id=new.id for update;
 if a.request_id is not null and a.active and (changed or not target_active) then
  -- Do not rewrite absence after that payroll was paid/finalized.
  if exists(select 1 from public.workforce_payout_payment_items i where i.company_id=a.company_id and i.workforce_id=a.workforce_id and a.work_date between i.period_start and i.period_end and i.status not in ('cancelled','failed'))
  or exists(select 1 from public.workforce_payout_effective_paid_allocations e where e.company_id=a.company_id and e.credited_workforce_id=a.workforce_id and a.work_date between e.period_start and e.period_end)
  or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.company_id=r.company_id and i.payroll_run_id=r.id where r.company_id=a.company_id and i.workforce_id=a.workforce_id and r.status in ('approved','paid') and i.status<>'excluded' and a.work_date between r.period_start and r.period_end) then raise exception 'Finance must review finalized payroll before releasing this absence.'; end if;
  update public.payment_adhoc_driver_absences set active=false,updated_at=now() where request_id=new.id;
  perform public.workforce_bump_payout_period_dependency_revision(a.company_id,a.work_date);
  for location in select distinct station_id from public.workforce_payout_publications where company_id=a.company_id and workforce_id=a.workforce_id and a.work_date between period_start and period_end and station_id is not null loop
   perform public.enqueue_workforce_payout_dependency_refresh(a.company_id,a.workforce_id,location,a.work_date,a.work_date,new.updated_by);
  end loop;
 end if;
 if target_active and d->>'workforce_id' is not null and (changed or not coalesce(a.active,false)) then
  d:=public.validate_adhoc_driver_request(new.company_id,new.location_code,d,new.id);
  insert into public.payment_adhoc_driver_absences(request_id,company_id,workforce_id,station_id,work_date,request_no,active)
   values(new.id,new.company_id,(d->>'workforce_id')::uuid,new.location_id,(d->>'work_date')::date,new.request_no,true)
   on conflict(request_id) do update set workforce_id=excluded.workforce_id,station_id=excluded.station_id,work_date=excluded.work_date,request_no=excluded.request_no,active=true,updated_at=now();
  perform public.workforce_bump_payout_period_dependency_revision(new.company_id,(d->>'work_date')::date);
  perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,(d->>'workforce_id')::uuid,new.location_id,(d->>'work_date')::date,(d->>'work_date')::date,new.updated_by);
  for location in select distinct station_id from public.workforce_payout_publications where company_id=new.company_id and workforce_id=(d->>'workforce_id')::uuid and (d->>'work_date')::date between period_start and period_end and station_id is not null and station_id<>new.location_id loop
   perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,(d->>'workforce_id')::uuid,location,(d->>'work_date')::date,(d->>'work_date')::date,new.updated_by);
  end loop;
 end if;
 if changed or (tg_op='UPDATE' and old.status is distinct from new.status) then
  insert into public.payment_adhoc_driver_events(company_id,request_id,actor_id,event,before_data,after_data)
  values(new.company_id,new.id,coalesce(new.updated_by,new.requested_by),'request:'||new.status,prior,new.details->'adhoc_driver');
 end if;
 return new;
end;
$$;
drop trigger if exists payment_adhoc_driver_guard on public.payment_requests;
create trigger payment_adhoc_driver_guard before insert or update or delete on public.payment_requests for each row execute function public.payment_adhoc_driver_guard();
revoke all on function public.adhoc_driver_request_context(uuid,uuid,date),public.validate_adhoc_driver_request(uuid,text,jsonb,uuid),public.payment_adhoc_driver_guard() from public,anon,authenticated;
grant execute on function public.adhoc_driver_request_context(uuid,uuid,date),public.validate_adhoc_driver_request(uuid,text,jsonb,uuid),public.payment_adhoc_driver_guard() to service_role;
notify pgrst,'reload schema';
commit;
