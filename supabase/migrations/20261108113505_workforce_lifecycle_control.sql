-- Canonical Workforce lifecycle. No records or payroll history are deleted.
create table if not exists public.workforce_status_controls (
 company_id uuid not null, workforce_id uuid not null references public.workforce(id),
 status text not null check(status in ('active','onboarding','inactive','offboarded')),
 version integer not null default 1, reason text not null, changed_by uuid,
 changed_at timestamptz not null default now(), rejoined_at timestamptz,
 primary key(company_id,workforce_id)
);
create table if not exists public.workforce_status_events (
 id uuid primary key default gen_random_uuid(), company_id uuid not null,
 workforce_id uuid not null references public.workforce(id), action text not null,
 from_status text, to_status text not null, reason text not null, actor_id uuid,
 evidence jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists workforce_status_events_person on public.workforce_status_events(company_id,workforce_id,created_at desc);
alter table public.workforce_status_controls enable row level security;
alter table public.workforce_status_events enable row level security;
revoke all on public.workforce_status_controls,public.workforce_status_events from anon,authenticated;
grant select,insert,update on public.workforce_status_controls to service_role;
grant select,insert on public.workforce_status_events to service_role;

-- One company-wide scan, one row per canonical DropX identity. A missing delivery
-- history is UNKNOWN, never evidence for the 30-day rule. Every linked station
-- must have all 30 daily partitions; newer pickups/attendance protect workers.
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
), base as (
 select w.id,w.dropx_id,w.full_name,w.mobile,w.mobile_country_code,w.location_id,s.station_code,
 w.onboarding_status,w.lifecycle_status,w.is_active,w.updated_at,w.provider_employee_id,
 coalesce(k.version,0) version,coalesce(k.status,w.lifecycle_status,'onboarding') control_status,
 k.rejoined_at,coalesce(m.provider_ids,w.provider_employee_id) provider_ids,
 m.last_delivery,m.last_activity,a.last_punch,coalesce(c.days,0) feed_days,c.feed_through,
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
 when is_active and provider_mapping_required and last_delivery<(select today-30 from clock)
   and (rejoined_at is null or rejoined_at<now()-interval '30 days') then
   case when not approved_leave and feeds_complete and coalesce(last_activity,last_delivery)<(select today-30 from clock)
   and (last_punch is null or last_punch<(select today-30 from clock)) then 'delivery_inactive' else 'delivery_exception' end
 when onboarding_status in('pending','returned') and action_due_since<now()-interval '15 days' then
   case when submission_evidence or provider_or_work_evidence or recent_draft or last_punch is not null then 'registration_exception' else 'registration_overdue' end
 when control_status='inactive' or not is_active then 'inactive'
 else 'current' end queue
 from base b
)
select to_jsonb(c)||jsonb_build_object('as_of',(select today from clock),
 'days_without_delivery',(select today from clock)-last_delivery,
 'reason',case queue
 when 'registration_overdue' then 'Registration unfinished for 15+ days; no submission, provider or work evidence.'
 when 'registration_exception' then case when recent_draft then 'Associate responded within 15 days; review saved registration.'
 when submission_evidence then 'Registration submission recorded; review/provider delay needs resolution.'
 when last_punch is not null then 'Attendance exists despite unfinished registration; reconcile before exit.'
 else 'Provider ID, invitation or payment/work history exists; reconcile before exit.' end
 when 'delivery_inactive' then 'No mapped deliveries or other recorded work for over 30 days; daily station feeds present.'
 when 'delivery_exception' then case when approved_leave then 'Approved leave protects this associate from automatic inactivation.'
 when not feeds_complete then 'Delivery feed is incomplete for at least one linked station; inactivity is unconfirmed.'
 else 'Newer attendance or other work exists; review before inactivation.' end
 when 'exit_pending' then 'An existing exit case needs a decision.'
 when 'inactive' then 'Inactive. Reactivate on return after checking identity and current assignment.'
 when 'offboarded' then 'Offboarded. Rejoin keeps this DropX ID and starts a fresh registration review.'
 else 'No overdue lifecycle action.' end) from classified c;
$fn$;
revoke all on function public.workforce_lifecycle_audit(uuid) from public,anon,authenticated;
grant execute on function public.workforce_lifecycle_audit(uuid) to service_role;

-- Prevent a late legacy sync or stale registration update undoing an exit.
create or replace function public.workforce_status_control_guard()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare v_status text;
begin
 select status into v_status from public.workforce_status_controls where company_id=new.company_id and workforce_id=new.id;
 if v_status in('inactive','offboarded') then
  new.lifecycle_status:=v_status; new.is_active:=false;
  new.deactivated_at:=coalesce(new.deactivated_at,now());
 end if;
 return new;
end $fn$;
drop trigger if exists workforce_zy_status_control on public.workforce;
create trigger workforce_zy_status_control before update on public.workforce for each row execute function public.workforce_status_control_guard();

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
 if p_automatic and not ((p_action='offboard' and a->>'queue'='registration_overdue') or
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

create table if not exists public.workforce_lifecycle_automation_settings (
 company_id uuid primary key, enabled boolean not null default false, updated_at timestamptz not null default now()
);
alter table public.workforce_lifecycle_automation_settings enable row level security;
revoke all on public.workforce_lifecycle_automation_settings from anon,authenticated;
grant select,insert,update on public.workforce_lifecycle_automation_settings to service_role;
create or replace function public.workforce_lifecycle_sweep()
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare co uuid; r jsonb; results jsonb:='[]'::jsonb; changed jsonb;
begin
 if not pg_try_advisory_xact_lock(hashtext('workforce-lifecycle-sweep')) then return jsonb_build_object('already_running',true); end if;
 for co in select company_id from public.workforce_lifecycle_automation_settings where enabled loop
  for r in select x from public.workforce_lifecycle_audit(co) x where x->>'queue' in('registration_overdue','delivery_inactive') limit 30 loop
   begin
    changed:=public.workforce_lifecycle_transition(co,(r->>'id')::uuid,
     case r->>'queue' when 'registration_overdue' then 'offboard' else 'inactivate' end,
     null,r->>'reason',(r->>'updated_at')::timestamptz,(r->>'version')::integer,true);
    results:=results||jsonb_build_array(changed);
   exception when others then
    results:=results||jsonb_build_array(jsonb_build_object('id',r->>'id','error',sqlerrm));
   end;
  end loop;
 end loop;
 return results;
end $fn$;
revoke all on function public.workforce_lifecycle_sweep() from public,anon,authenticated;
grant execute on function public.workforce_lifecycle_sweep() to service_role;

create or replace function public.workforce_status_events_immutable()
returns trigger language plpgsql set search_path='' as $fn$
begin raise exception 'Workforce lifecycle history is append-only.'; end $fn$;
drop trigger if exists workforce_status_events_immutable on public.workforce_status_events;
create trigger workforce_status_events_immutable before update or delete on public.workforce_status_events
for each row execute function public.workforce_status_events_immutable();
revoke all on function public.workforce_status_events_immutable() from public,anon,authenticated;
