-- Keep the Ops projection aligned with People’s holiday / workday overrides and actual WFH dates.
-- Read-only projection. No HR case synchronization, notes, medical reasons or mutations.
-- Service-role only: the Next server derives company, user, owner and location scope from its verified session.
create or replace function public.ops_unplanned_leave_workspace(
 p_company_id uuid,p_user_id uuid,p_attendance_date date,p_owner boolean default false,
 p_location_ids uuid[] default '{}',p_location_role_codes text[] default '{}'
) returns jsonb language plpgsql stable security invoker set search_path='' as $fn$
declare
 v_person_id uuid; v_location_account boolean:=false; v_grace integer; v_enabled boolean; v_result jsonb;
begin
 if p_attendance_date is null or p_attendance_date>(now() at time zone 'Asia/Kolkata')::date
 then raise exception 'Choose a valid attendance date up to today.' using errcode='22023'; end if;
 if not exists(select 1 from public.profiles where id=p_user_id and company_id=p_company_id and is_active)
 then raise exception 'Active company access required.' using errcode='42501'; end if;
 if not p_owner and not exists(select 1 from public.company_product_memberships
 where company_id=p_company_id and user_id=p_user_id and product_code='operations' and is_active)
 then raise exception 'Operations membership required.' using errcode='42501'; end if;
 select person_id into v_person_id from public.hr_user_person_links
 where company_id=p_company_id and user_id=p_user_id and status='active';
 select exists(select 1 from public.company_product_memberships m
 left join public.user_roles ur on ur.company_id=m.company_id and ur.id=m.role_id
 where m.company_id=p_company_id and m.user_id=p_user_id and m.product_code='operations' and m.is_active
 and (m.source_system='location_master' or ur.code='OPERATIONS_LOCATION')) into v_location_account;
 if not p_owner and not v_location_account and v_person_id is null
 then raise exception 'Reporting profile is not linked. Ask HR to check your People mapping.' using errcode='42501'; end if;
 select unplanned_leave_grace_minutes,unplanned_leave_enabled into v_grace,v_enabled
 from public.hr_company_settings where company_id=p_company_id;
 if v_grace is null or v_enabled is null then raise exception 'Unplanned leave policy is unavailable.'; end if;
 with recursive params as (select p_company_id company_id,p_attendance_date attendance_date,(now() at time zone 'Asia/Kolkata')::date routing_date),
workers as (
 select e.company_id,'employee'::text worker_type,e.id worker_id,e.full_name,e.employee_code worker_code,e.biometric_id,e.date_of_join,e.location_id,e.department_id,e.designation_id,null::text designation_name,e.email,e.mobile,e.people_lifecycle_status,e.last_working_date
 from public.employees e,params p where e.company_id=p.company_id and e.is_active and e.deleted_at is null
 union all
 select c.company_id,'contractor',c.id,c.full_name,c.dropx_id,c.biometric_id,c.date_of_join,c.location_id,c.department_id,null,c.designation,c.email,c.mobile,c.people_lifecycle_status,c.last_working_date
 from public.contractors c,params p where c.company_id=p.company_id and c.is_active and c.deleted_at is null
),
base_graph as (
 select distinct on (hp.id) a.id assignment_id,hp.id person_id,hp.display_name,he.worker_type,coalesce(he.employee_id,he.contractor_id) worker_id,he.worker_code,
 a.location_id,s.station_code,s.station_name,d.code designation_code,coalesce(d.name,a.position_title) designation_name,dep.name department_name,

 rel.manager_assignment_id,hp.status person_status,dc.people_module
 from params p
 join public.hr_people hp on hp.company_id=p.company_id and hp.status='active'
 join public.hr_engagements he on he.company_id=p.company_id and he.person_id=hp.id and he.status='active' and he.start_date<=p.routing_date and (he.end_date is null or he.end_date>=p.routing_date)
 join public.hr_work_assignments a on a.company_id=p.company_id and a.engagement_id=he.id and a.is_primary and a.effective_from<=p.routing_date and (a.effective_to is null or a.effective_to>=p.routing_date)
 left join workers w on w.company_id=p.company_id and w.worker_id=coalesce(he.employee_id,he.contractor_id) and w.worker_type=he.worker_type
 left join public.designations d on d.company_id=p.company_id and d.id=a.designation_id and d.is_active
 left join public.designation_categories dc on dc.id=d.designation_category_id and dc.is_active
 left join public.hr_departments dep on dep.company_id=p.company_id and dep.id=a.department_id
 left join public.stations s on s.company_id=p.company_id and s.id=a.location_id
 left join lateral(select rr.manager_assignment_id from public.hr_reporting_relationships rr
 where rr.company_id=p.company_id and rr.subject_assignment_id=a.id and rr.is_primary and rr.relationship_type='solid_line'
 and rr.effective_from<=p.routing_date and (rr.effective_to is null or rr.effective_to>=p.routing_date)
 order by rr.effective_from desc limit 1) rel on true
 order by hp.id,a.effective_from desc,a.id
),
lineage as (
 select b.person_id,b.manager_assignment_id,array[b.assignment_id] seen,array[]::uuid[] manager_person_ids from base_graph b
 union all
 select l.person_id,b.manager_assignment_id,l.seen||b.assignment_id,l.manager_person_ids||b.person_id
 from lineage l join base_graph b on b.assignment_id=l.manager_assignment_id where not b.assignment_id=any(l.seen)
),
graph as (
 select b.*,x.manager_person_ids from base_graph b
 join lateral (select l.manager_person_ids from lineage l where l.person_id=b.person_id order by cardinality(l.manager_person_ids) desc limit 1) x on true
),
roster as (
 select distinct on (w.worker_type,w.worker_id) w.*,p.attendance_date,g.person_id,g.assignment_id,g.manager_assignment_id,g.manager_person_ids,
 coalesce(r.location_id,g.location_id,w.location_id) current_location_id,coalesce(g.designation_name,w.designation_name) role_name,g.department_name,
 r.day_type,sh.code shift_code,sh.start_time shift_start,sh.end_time shift_end
 from workers w join params p on p.company_id=w.company_id
 join graph g on g.worker_id=w.worker_id and g.worker_type=w.worker_type and g.people_module='people_hr'
 and (p_owner or (v_location_account and g.location_id=any(p_location_ids) and g.designation_code=any(p_location_role_codes))
 or (not v_location_account and g.person_id<>v_person_id and v_person_id=any(g.manager_person_ids)))
 join public.hr_roster_entries r on r.company_id=p.company_id and r.worker_id=w.worker_id and r.worker_type=w.worker_type
 join public.hr_roster_plans plan on plan.company_id=p.company_id and plan.id=r.plan_id and plan.status='approved'
 and coalesce(plan.effective_from,p.attendance_date)<=p.attendance_date and (plan.superseded_at is null or p.attendance_date<plan.superseded_at)
 and ((plan.roster_kind='dated' and r.roster_date=p.attendance_date) or (plan.roster_kind='recurring_weekly' and extract(isodow from r.roster_date)=extract(isodow from p.attendance_date)))
 left join public.hr_shifts sh on sh.company_id=p.company_id and sh.id=r.shift_id
 where (w.date_of_join is null or w.date_of_join<=p.attendance_date)
 order by w.worker_type,w.worker_id,(plan.roster_kind='dated') desc,
 case when plan.roster_kind='recurring_weekly' then plan.effective_from end desc,
 plan.revision_no desc nulls last,plan.effective_from desc,r.id
),
evidence as (
 select r.*,s.station_code,s.station_name,s.station_email,s.cluster,s.region,
 coalesce((select cal.day_type='paid_holiday' from public.hr_payroll_calendar_days cal
 where cal.company_id=r.company_id and cal.is_active and cal.calendar_date=r.attendance_date
 and (cal.location_id is null or cal.location_id=r.current_location_id)
 order by (cal.location_id is not null) desc,cal.id limit 1),false) calendar_holiday,
 exists(select 1 from public.attendance_daily ad where ad.company_id=r.company_id and ad.punch_date=r.attendance_date
 and ad.status in ('H','WO','L','V') and ad.field_executive_id is null and ad.workforce_id is null
 and ((r.worker_type='employee' and ad.employee_id=r.worker_id) or (r.worker_type='contractor' and ad.contractor_id=r.worker_id))) nonworking_status,
 exists(select 1 from public.attendance_daily ad where ad.company_id=r.company_id and ad.punch_date=r.attendance_date and ad.status<>'U'
 and ad.field_executive_id is null and ad.workforce_id is null and (ad.punch_count>0 or ad.in_time is not null or ad.out_time is not null)
 and ((r.worker_type='employee' and ad.worker_type='employee') or (r.worker_type='contractor' and ad.worker_type in ('contractor','individual_contract')))
 and (coalesce(case when r.worker_type='employee' then ad.employee_id else ad.contractor_id end,ad.employee_id)=r.worker_id
 or (ad.employee_id is null and ad.contractor_id is null and nullif(r.biometric_id,'') is not null and ltrim(ad.enrolment_id,'0')=ltrim(r.biometric_id,'0')))) daily_punch,
 exists(select 1 from public.attendance_punches ap where ap.company_id=r.company_id and (ap.punch_date=r.attendance_date or (r.shift_end<=r.shift_start and coalesce(ap.client_captured_at,ap.punch_time) between ((r.attendance_date+r.shift_start) at time zone 'Asia/Kolkata') and ((r.attendance_date+1+r.shift_end) at time zone 'Asia/Kolkata')))
 and ap.punch_date between r.attendance_date and r.attendance_date+1
 and ap.field_executive_id is null and coalesce(ap.profile_type,'') not in ('workforce','field_executive')
 and ((r.worker_type='employee' and ap.worker_type='employee') or (r.worker_type='contractor' and ap.worker_type in ('contractor','individual_contract')))
 and (coalesce(case when r.worker_type='employee' then ap.employee_id else ap.contractor_id end,ap.account_id,ap.employee_id)=r.worker_id
 or (ap.account_id is null and ap.employee_id is null and ap.contractor_id is null and nullif(r.biometric_id,'') is not null and ltrim(ap.enrolment_id,'0')=ltrim(r.biometric_id,'0')))) raw_punch,
 exists(select 1 from public.hr_leave_requests l where l.company_id=r.company_id and l.status='approved' and r.attendance_date between l.start_date and l.end_date
 and ((r.worker_type='employee' and l.employee_id=r.worker_id) or (r.worker_type='contractor' and l.contractor_id=r.worker_id))) approved_leave,
 exists(select 1 from public.hr_wfh_requests f where f.company_id=r.company_id and f.status='approved' and f.profile_id=r.worker_id and f.profile_type=r.worker_type and r.attendance_date between f.start_date and f.end_date
 and (f.applied_dates is null or f.applied_dates='[]'::jsonb or f.applied_dates @> jsonb_build_array(r.attendance_date::text))) approved_wfh,
 exists(select 1 from public.attendance_regularization_requests ar where ar.company_id=r.company_id and ar.profile_id=r.worker_id and ar.profile_type=r.worker_type and ar.attendance_date=r.attendance_date and ar.status in ('pending','approved')
 and (ar.requested_in_time is not null or ar.requested_out_time is not null)) regularization,
 exists(select 1 from public.hr_unplanned_leave_cases c join public.hr_unplanned_leave_statuses st on st.company_id=c.company_id and st.id=c.status_id where c.company_id=r.company_id and c.worker_id=r.worker_id and c.worker_type=r.worker_type and c.attendance_date=r.attendance_date and (c.excluded_at is not null or c.resolved_at is not null or st.is_terminal)) case_closed
 from roster r left join public.stations s on s.company_id=r.company_id and s.id=r.current_location_id
),
candidates as (
 select person_id,assignment_id,worker_type,worker_id,worker_code,full_name,mobile,role_name,department_name,manager_assignment_id,manager_person_ids,current_location_id location_id,station_code,station_name,cluster,region,attendance_date,shift_code,shift_start,shift_end
 from evidence where day_type='working' and nullif(trim(biometric_id),'') is not null and shift_start is not null
 and ((attendance_date+shift_start) at time zone 'Asia/Kolkata') + make_interval(mins=>v_grace) <= now()
 and not calendar_holiday and not nonworking_status
 and (not v_location_account or current_location_id=any(p_location_ids))
 and not daily_punch and not raw_punch and not approved_leave and not approved_wfh and not regularization and not case_closed
 and v_enabled
 and coalesce(people_lifecycle_status,'active')='active' and (last_working_date is null or last_working_date>=attendance_date)
)
select jsonb_build_object(
 'date',p_attendance_date,'checkedAt',now(),'graceMinutes',v_grace,'enabled',v_enabled,
 'scope',case when p_owner then 'company' when v_location_account then 'location' else 'reporting' end,
 'viewerPersonId',v_person_id,
 'rows',(select coalesce(jsonb_agg(c order by c.station_code,c.full_name),'[]'::jsonb) from candidates c),
 'managers',(select coalesce(jsonb_agg(jsonb_build_object('id',g.person_id,'name',g.display_name,'role',g.designation_name,'managerPersonIds',g.manager_person_ids)),'[]'::jsonb)
 from graph g where exists(select 1 from graph child where child.manager_assignment_id=g.assignment_id)
 and (p_owner or (not v_location_account and (g.person_id=v_person_id or v_person_id=any(g.manager_person_ids)))))
) into v_result;
return v_result;
end;
$fn$;
revoke all on function public.ops_unplanned_leave_workspace(uuid,uuid,date,boolean,uuid[],text[]) from public,anon,authenticated;
grant execute on function public.ops_unplanned_leave_workspace(uuid,uuid,date,boolean,uuid[],text[]) to service_role;
