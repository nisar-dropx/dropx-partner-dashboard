-- Review-only rollout: this migration changes no associate statuses and never enables automation.
create table if not exists public.workforce_lifecycle_closed_stations (
 company_id uuid not null, station_code text not null, reason text not null,
 primary key(company_id,station_code)
);
alter table public.workforce_lifecycle_closed_stations enable row level security;
revoke all on public.workforce_lifecycle_closed_stations from anon,authenticated;
grant select on public.workforce_lifecycle_closed_stations to service_role;
-- Explicit closure evidence supplied by the Managing Partner on 8 November.
insert into public.workforce_lifecycle_closed_stations(company_id,station_code,reason)
select company_id,station_code,'Closure confirmed by Managing Partner on 2026-11-08'
from public.stations where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
and station_code in('ERSE','AWEZ','SBPD','JUGE')
on conflict do nothing;

-- The canonical identity trigger rewrites legacy owners to workforce and clears
-- field_executive_id. Keep the owner shape check, including that canonical shape.
alter table public.biometric_enrolments drop constraint if exists biometric_enrolments_owner_shape_check;
alter table public.biometric_enrolments add constraint biometric_enrolments_owner_shape_check check (
 (profile_type='employee' and worker_type='employee' and account_id is not null and employee_id=account_id and field_executive_id is null)
 or (profile_type='field_executive' and worker_type='individual_contract' and account_id is not null and field_executive_id=account_id and employee_id is null)
 or (profile_type in('contractor','vendor','worker','workforce') and worker_type='individual_contract' and account_id is not null and employee_id is null and field_executive_id is null)
 or (profile_type is null and ((worker_type='employee' and employee_id is not null and field_executive_id is null)
 or (worker_type='individual_contract' and field_executive_id is not null and employee_id is null)))
) not valid;

create table if not exists public.workforce_lifecycle_failures (
 company_id uuid not null,workforce_id uuid not null references public.workforce(id),error text not null,
 attempted_at timestamptz not null default now(),attempts integer not null default 1,
 primary key(company_id,workforce_id)
);
alter table public.workforce_lifecycle_failures enable row level security;
revoke all on public.workforce_lifecycle_failures from anon,authenticated;
grant select,insert,update,delete on public.workforce_lifecycle_failures to service_role;
create or replace function public.workforce_lifecycle_audit(p_company uuid)
returns setof jsonb language sql stable security definer set search_path='' as $fn$
with clock as (select (now() at time zone 'Asia/Kolkata')::date today),
attendance_keys as materialized (
 select v.key,max(ad.punch_date) last_punch from public.attendance_daily ad
 cross join lateral (values ('w:'||ad.workforce_id::text),('f:'||ad.field_executive_id::text),
 ('c:'||ad.contractor_id::text),('b:'||ad.employee_code)) v(key)
 where ad.company_id=p_company and ad.punch_count>0 and v.key is not null group by v.key
), work_codes as materialized (
 select distinct dropx_emp_code from public.cps_shipment_daily where company_id=p_company and total_activity>0 and dropx_emp_code is not null
),
coverage as (
 select station_code,max(work_date) feed_through,
 count(distinct work_date) filter(where work_date >= (select today-30 from clock) and work_date < (select today from clock)) days
 from public.cps_shipment_daily where company_id=p_company group by station_code
), maps as (
 select m.workforce_id,string_agg(distinct m.provider_member_id,', ' order by m.provider_member_id) provider_ids,
 max(f.work_date) filter(where f.total_delivery>0) last_delivery,
 max(f.work_date) filter(where f.total_activity>0) last_activity,
 bool_and(coalesce(c.days,0)=30) mapping_feeds_complete
 from public.field_executive_provider_mappings m
 join public.stations s on s.id=m.station_id and s.company_id=m.company_id
 left join coverage c on c.station_code=s.station_code
 left join public.workforce_payout_shipment_facts f on f.company_id=m.company_id
 and f.provider_employee_id=m.provider_member_id and f.station_code=s.station_code
 and f.work_date between m.effective_from and coalesce(m.effective_to,(select today from clock))
 where m.company_id=p_company and m.status in('active','closed') group by m.workforce_id
), linked_ids as (
 select workforce_id,provider_member_id provider_id from public.field_executive_provider_mappings
 where company_id=p_company and status in('active','closed')
 union select id,provider_employee_id from public.workforce where company_id=p_company and nullif(provider_employee_id,'') is not null
), global_work as (
 select i.workforce_id,max(f.work_date) filter(where f.total_delivery>0) last_delivery_anywhere,
 max(f.work_date) filter(where f.total_activity>0) last_activity_anywhere
 from linked_ids i join public.workforce_payout_shipment_facts f on f.company_id=p_company and f.provider_employee_id=i.provider_id
 group by i.workforce_id
), raw_work as (
 select dropx_emp_code,max(work_date) filter(where total_activity>0) last_activity
 from public.cps_shipment_daily where company_id=p_company and dropx_emp_code is not null group by dropx_emp_code
), base as (
 select w.id,w.dropx_id,w.full_name,w.mobile,w.mobile_country_code,w.location_id,s.station_code,
 w.onboarding_status,w.lifecycle_status,w.is_active,w.updated_at,w.provider_employee_id,
 coalesce(k.version,0) version,coalesce(k.status,w.lifecycle_status,'onboarding') control_status,
 k.rejoined_at,coalesce(m.provider_ids,w.provider_employee_id) provider_ids,
 m.last_delivery,m.last_activity,a.last_punch,g.last_delivery_anywhere,
 greatest(g.last_activity_anywhere,rw.last_activity) last_activity_anywhere,
 exists(select 1 from public.workforce_lifecycle_closed_stations cs where cs.company_id=p_company and cs.station_code=s.station_code) station_closed,
 exists(select 1 from public.workforce other where other.company_id=p_company and other.id<>w.id and other.deleted_at is null
 and other.migration_state not in('reclassified','moved_to_vendor') and nullif(w.mobile,'')=other.mobile) duplicate_mobile,
coalesce(c.days,0) feed_days,c.feed_through,
 greatest(w.created_at,w.profile_returned_at,k.rejoined_at) action_due_since,
 d.provider_mapping_required,
 coalesce(m.mapping_feeds_complete,false) and coalesce(c.days,0)=30 feeds_complete,
 (w.onboarding_submitted_at is not null or w.onboarding_approved_at is not null or
 exists(select 1 from public.workforce_onboarding_events e where e.company_id=p_company
 and (e.workforce_id=w.id or e.field_executive_id=w.id or e.field_executive_id=w.source_profile_id)
 and e.event_code in('candidate_submitted','ho_approved_and_activated'))) submission_evidence,
 (m.workforce_id is not null or nullif(w.provider_employee_id,'') is not null or w.provider_id_status in('created','in_progress') or
 exists(select 1 from public.workforce_amazon_invitation_requests ar where ar.company_id=p_company and ar.workforce_id=w.id) or
 exists(select 1 from public.workforce_amazon_email_pilot_candidates pc where pc.company_id=p_company and lower(pc.alias_email)=lower(w.email)) or
 exists(select 1 from public.workforce_payment_allocations pa where pa.company_id=p_company and pa.workforce_id=w.id and pa.status in('active','closed')) or
 exists(select 1 from work_codes f where f.dropx_emp_code=w.dropx_id)) provider_or_work_evidence,
 exists(select 1 from public.mob_app_registration_drafts dr where dr.company_id=p_company
 and (dr.account_id=w.id or dr.account_id=w.source_profile_id) and dr.updated_at>now()-interval '15 days') recent_draft,
 exists(select 1 from public.hr_leave_requests lr where lr.company_id=p_company and (lr.requested_profile_id=w.id or lr.contractor_id=w.source_profile_id) and lr.status='approved' and lr.end_date>=(select today-30 from clock)) approved_leave,
 exists(select 1 from public.workforce_lifecycle_cases lc where lc.company_id=p_company and
 (lc.profile_id=w.id or lc.field_executive_id=w.id) and lc.status in('submitted','under_review','settlement_pending')) open_exit
 from public.workforce w join public.stations s on s.id=w.location_id and s.company_id=w.company_id
 left join public.designations d on d.id=w.designation_id
 left join public.workforce_status_controls k on k.company_id=w.company_id and k.workforce_id=w.id
 left join global_work g on g.workforce_id=w.id left join raw_work rw on rw.dropx_emp_code=w.dropx_id
 left join maps m on m.workforce_id=w.id left join coverage c on c.station_code=s.station_code
 left join lateral (
 select max(ak.last_punch) last_punch from attendance_keys ak where ak.key in('w:'||w.id::text,'f:'||w.id::text,'c:'||w.source_profile_id::text,'b:'||nullif(w.biometric_id,''))
 ) a on true
 where w.company_id=p_company and w.deleted_at is null and nullif(w.dropx_id,'') is not null
 and w.migration_state not in('reclassified','moved_to_vendor')
), classified as (
 select b.*,case
 when control_status in('offboarded','exited','terminated','resigned','settled') then 'offboarded'
 when open_exit then 'exit_pending'
 when station_closed and not duplicate_mobile and not approved_leave
 and last_delivery_anywhere<(select today-30 from clock)
 and coalesce(last_activity_anywhere,last_delivery_anywhere)<(select today-30 from clock)
 and (last_punch is null or last_punch<(select today-30 from clock))
 and (rejoined_at is null or rejoined_at<now()-interval '30 days') then 'closed_station_exit'
 when control_status='inactive' then 'inactive'
 when is_active and provider_mapping_required and last_delivery<(select today-30 from clock)
   and (rejoined_at is null or rejoined_at<now()-interval '30 days') then
   case when not duplicate_mobile and not approved_leave and feeds_complete
   and coalesce(last_activity_anywhere,last_delivery)<(select today-30 from clock) and coalesce(last_activity,last_delivery)<(select today-30 from clock)
   and (last_punch is null or last_punch<(select today-30 from clock)) then 'delivery_inactive' else 'delivery_exception' end
 when onboarding_status in('pending','returned') and action_due_since<now()-interval '15 days' then
   case when duplicate_mobile or submission_evidence or provider_or_work_evidence or recent_draft or last_punch is not null then 'registration_exception' else 'registration_overdue' end
 when control_status='inactive' or not is_active then 'inactive'
 else 'current' end queue
 from base b
)
select to_jsonb(c)||jsonb_build_object('as_of',(select today from clock),
 'days_without_delivery',(select today from clock)-last_delivery,
 'reason',case queue
 when 'registration_overdue' then 'Registration unfinished for 15+ days; no submission, provider or work evidence.'
 when 'closed_station_exit' then 'Confirmed closed station; no linked-ID delivery or work across stations for over 30 days. Final exit candidate.'
 when 'registration_exception' then case when duplicate_mobile then 'Mobile matches another DropX identity; reconcile before exit.'
 when recent_draft then 'Associate responded within 15 days; review saved registration.'
 when submission_evidence then 'Registration submission recorded; review/provider delay needs resolution.'
 when last_punch is not null then 'Attendance exists despite unfinished registration; reconcile before exit.'
 else 'Provider ID, invitation or payment/work history exists; reconcile before exit.' end
 when 'delivery_inactive' then 'No mapped deliveries or other recorded work for over 30 days; daily station feeds present.'
 when 'delivery_exception' then case when duplicate_mobile then 'Mobile matches another DropX identity; reconcile before exit.'
 when approved_leave then 'Approved leave protects this associate from automatic inactivation.'
 when not feeds_complete then 'Delivery feed is incomplete for at least one linked station; inactivity is unconfirmed.'
 else 'Newer attendance or other work exists; review before inactivation.' end
 when 'exit_pending' then 'An existing exit case needs a decision.'
 when 'inactive' then 'Inactive. Reactivate on return after checking identity and current assignment.'
 when 'offboarded' then 'Offboarded. Rejoin keeps this DropX ID and starts a fresh registration review.'
 else 'No overdue lifecycle action.' end) from classified c;
$fn$;
revoke all on function public.workforce_lifecycle_audit(uuid) from public,anon,authenticated;
grant execute on function public.workforce_lifecycle_audit(uuid) to service_role;

create or replace function public.workforce_lifecycle_transition(
 p_company uuid,p_workforce uuid,p_action text,p_actor uuid,p_reason text,
 p_expected_updated_at timestamptz,p_expected_version integer,p_automatic boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare w public.workforce%rowtype; k public.workforce_status_controls%rowtype;
 a jsonb; old_status text; next_status text; next_registration text; event_id uuid;
begin
 if length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Enter a reason of at least five characters.'; end if;
 if p_action not in('inactivate','offboard','reactivate','rejoin') then raise exception 'Unknown lifecycle action.'; end if;
 if not p_automatic and not exists(select 1 from public.profiles where id=p_actor and company_id=p_company and is_active) then raise exception 'An active company actor is required.'; end if;
 select * into w from public.workforce where id=p_workforce and company_id=p_company for update;
 if not found or w.deleted_at is not null then raise exception 'Workforce profile not available.'; end if;
 if w.updated_at is distinct from p_expected_updated_at then raise exception 'Profile changed. Refresh and retry.'; end if;
 select * into k from public.workforce_status_controls where company_id=p_company and workforce_id=w.id for update;
 if coalesce(k.version,0)<>p_expected_version then raise exception 'Lifecycle changed. Refresh and retry.'; end if;
 select x into a from public.workforce_lifecycle_audit(p_company) x where x->>'id'=w.id::text;
 if a is null then raise exception 'Profile is outside the Workforce lifecycle.'; end if;
 old_status:=coalesce(k.status,w.lifecycle_status,'onboarding');
 if p_automatic and not ((p_action='offboard' and a->>'queue' in('registration_overdue','closed_station_exit')) or
  (p_action='inactivate' and a->>'queue'='delivery_inactive')) then raise exception 'Automatic eligibility changed; profile left untouched.'; end if;
 if (a->>'open_exit')::boolean then raise exception 'Resolve the existing exit case before changing this profile.'; end if;
 if p_action in('inactivate','offboard') and a->>'queue'='offboarded' then raise exception 'Already offboarded. Use Rejoin.'; end if;
 if p_action='inactivate' and a->>'queue'='inactive' then raise exception 'Already inactive.'; end if;
 if p_action='reactivate' and a->>'queue'<>'inactive' then raise exception 'Only inactive associates can reactivate.'; end if;
 if p_action='rejoin' and a->>'queue' not in('inactive','offboarded') then raise exception 'Rejoin requires an inactive or offboarded profile.'; end if;
 if p_action='reactivate' and w.onboarding_status<>'active' then raise exception 'Registration is incomplete. Use Rejoin to resume registration.'; end if;
 next_status:=case p_action when 'inactivate' then 'inactive' when 'offboard' then 'offboarded' when 'reactivate' then 'active' else 'onboarding' end;
 next_registration:=case when p_action='rejoin' then 'pending' when p_action='offboard' and w.onboarding_status in('pending','returned') then 'cancelled' else w.onboarding_status end;
 insert into public.workforce_status_controls(company_id,workforce_id,status,version,reason,changed_by,rejoined_at)
 values(p_company,w.id,next_status,coalesce(k.version,0)+1,p_reason,p_actor,case when p_action in('rejoin','reactivate') then now() else k.rejoined_at end)
 on conflict(company_id,workforce_id) do update set status=excluded.status,version=excluded.version,reason=excluded.reason,
 changed_by=excluded.changed_by,changed_at=now(),rejoined_at=excluded.rejoined_at;
 -- The existing direct-pay trigger can restore an employment cutoff. A return is
 -- a new tenure, so do not restore a pay period across the inactive interval.
 if p_action in('rejoin','reactivate') then
  update public.workforce_payment_allocations set transition_restore_state=null
  where company_id=p_company and workforce_id=w.id and transition_restore_state->>'kind'='employment_cutoff';
 end if;
 update public.workforce set lifecycle_status=next_status,onboarding_status=next_registration,
 is_active=next_status in('active','onboarding'),
 deactivated_at=case when next_status in('inactive','offboarded') then now() else null end,
 deactivated_by=case when next_status in('inactive','offboarded') then p_actor else null end,
 last_working_date=case when p_action='offboard' then (now() at time zone 'Asia/Kolkata')::date
   when p_action in('reactivate','rejoin') then null else last_working_date end,
 onboarding_submitted_at=case when p_action='rejoin' then null else onboarding_submitted_at end,
 onboarding_reviewed_at=case when p_action='rejoin' then null else onboarding_reviewed_at end,
 onboarding_approved_at=case when p_action='rejoin' then null else onboarding_approved_at end,
 onboarding_activated_at=case when p_action='rejoin' then null else onboarding_activated_at end,
 updated_at=now() where id=w.id and company_id=p_company;
 -- Date-bounded pay history remains payable; rejoin never silently resumes old rates.
 if p_action in('offboard','inactivate') then
  update public.field_executive_provider_mappings set status='cancelled',updated_at=now()
  where company_id=p_company and workforce_id=w.id and status='active' and effective_from>(now() at time zone 'Asia/Kolkata')::date;
  update public.field_executive_provider_mappings set effective_to=(now() at time zone 'Asia/Kolkata')::date,
  status='closed',updated_at=now() where company_id=p_company and workforce_id=w.id and status='active'
  and effective_from<=(now() at time zone 'Asia/Kolkata')::date and (effective_to is null or effective_to>(now() at time zone 'Asia/Kolkata')::date);
 end if;
 insert into public.workforce_status_events(company_id,workforce_id,action,from_status,to_status,reason,actor_id,evidence)
 values(p_company,w.id,p_action,old_status,next_status,p_reason,p_actor,
 a||jsonb_build_object('automatic',p_automatic,'registration_before',w.onboarding_status,
 'provider_status',case when nullif(a->>'provider_ids','') is null then 'no_linked_provider_id' else 'separate_provider_action_required' end)) returning id into event_id;
 return jsonb_build_object('id',w.id,'dropx_id',w.dropx_id,'status',next_status,'event_id',event_id,
 'provider_action_required',nullif(a->>'provider_ids','') is not null);
end $fn$;
revoke all on function public.workforce_lifecycle_transition(uuid,uuid,text,uuid,text,timestamptz,integer,boolean) from public,anon,authenticated;
grant execute on function public.workforce_lifecycle_transition(uuid,uuid,text,uuid,text,timestamptz,integer,boolean) to service_role;
revoke all on function public.workforce_status_control_guard() from public,anon,authenticated;

create or replace function public.workforce_lifecycle_sweep()
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare co uuid; r jsonb; results jsonb:='[]'::jsonb; changed jsonb;
begin
 if not pg_try_advisory_xact_lock(hashtext('workforce-lifecycle-sweep')) then return jsonb_build_object('already_running',true); end if;
 for co in select company_id from public.workforce_lifecycle_automation_settings where enabled loop
  for r in select x from public.workforce_lifecycle_audit(co) x
   left join public.workforce_lifecycle_failures f on f.company_id=co and f.workforce_id=(x->>'id')::uuid
   where x->>'queue' in('registration_overdue','delivery_inactive','closed_station_exit')
   and (f.attempted_at is null or f.attempted_at<now()-interval '1 hour')
   order by f.attempted_at nulls first,x->>'id' limit 30 loop
   exit when not exists(select 1 from public.workforce_lifecycle_automation_settings where company_id=co and enabled);
   begin
    changed:=public.workforce_lifecycle_transition(co,(r->>'id')::uuid,
     case when r->>'queue'='delivery_inactive' then 'inactivate' else 'offboard' end,
     null,r->>'reason',(r->>'updated_at')::timestamptz,(r->>'version')::integer,true);
    delete from public.workforce_lifecycle_failures where company_id=co and workforce_id=(r->>'id')::uuid;
    results:=results||jsonb_build_array(changed);
   exception when others then
    insert into public.workforce_lifecycle_failures(company_id,workforce_id,error)
    values(co,(r->>'id')::uuid,sqlerrm)
    on conflict(company_id,workforce_id) do update set error=excluded.error,attempted_at=now(),
     attempts=public.workforce_lifecycle_failures.attempts+1;
    results:=results||jsonb_build_array(jsonb_build_object('id',r->>'id','error',sqlerrm));
   end;
  end loop;
 end loop;
 return results;
end $fn$;
revoke all on function public.workforce_lifecycle_sweep() from public,anon,authenticated;
grant execute on function public.workforce_lifecycle_sweep() to service_role;

