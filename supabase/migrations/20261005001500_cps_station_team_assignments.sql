-- Station support roles are configurable People costs; managers above AOM
-- remain outside station CPS. These are setup defaults, not engine role checks.
update public.ops_cps_people_policies set mode='home',label='Station team',updated_at=now()
where designation_code in ('TL','ATL','SSA','PTSSA','SIC','STM','HI','HK','SRTR','QC','PC','PTPC','SM','SRSM')
  and head='UTR' and label='Station staff CTC' and effective_from='2026-09-01';
update public.ops_cps_people_policies set mode='excluded',updated_at=now()
where designation_code='RM' and mode='managed' and effective_from='2026-09-01';

-- Private calculation input. Return the full allocation universe so selecting
-- one station never reallocates a manager's entire CTC to that station.
create or replace function public.ops_cps_people_assignments(p_company uuid,p_from date,p_through date)
returns jsonb language sql stable security invoker set search_path=public as $$
with eligible as materialized (
 select e.id,e.employee_code,e.full_name,e.email,e.location_id,e.date_of_join,e.last_working_date,e.is_active,e.deleted_at,d.code designation,
 exists(select 1 from hr_work_assignments a join hr_engagements g on g.id=a.engagement_id and g.company_id=p_company where a.company_id=p_company and g.employee_id=e.id and a.location_id is not null) has_home_assignments
 from employees e join designations d on d.id=e.designation_id and d.company_id=p_company
 where e.company_id=p_company and (e.deleted_at is null or e.deleted_at::date>=p_from)
 and exists(select 1 from ops_cps_people_policies p where p.company_id=p_company and p.designation_code=d.code and p.mode in ('home','managed') and p.effective_from<=p_through)
), assignments as materialized (
 select a.id,g.employee_id,g.person_id,a.location_id,
 greatest(a.effective_from,g.start_date) effective_from,
 least(coalesce(a.effective_to,'infinity'::date),coalesce(g.end_date,'infinity'::date)) effective_to
 from hr_work_assignments a join hr_engagements g on g.id=a.engagement_id and g.company_id=p_company
 join eligible e on e.id=g.employee_id
 where a.company_id=p_company and a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from
 and g.start_date<=p_through and coalesce(g.end_date,p_through)>=p_from
), mapped as materialized (
 select a.employee_id,r.station_id,'managed'::text kind,
 greatest(a.effective_from,(r.effective_from at time zone 'Asia/Kolkata')::date) effective_from,
 least(a.effective_to,coalesce((r.effective_to at time zone 'Asia/Kolkata')::date,'infinity'::date)) effective_to
 from assignments a join station_responsibility_assignments r on r.company_id=p_company
 and (r.assignment_id=a.id or (r.assignment_id is null and exists(
   select 1 from hr_user_person_links l where l.company_id=p_company and l.person_id=a.person_id and l.user_id=r.assignee_user_id and l.status='active'
 )))
 where r.is_primary
 union
 select employee_id,location_id,'home'::text,effective_from,effective_to from assignments where location_id is not null
), operating as materialized (
 select id,station_code,is_active,hide_from_location_list,is_ho
 from stations where company_id=p_company and is_active and not coalesce(is_ho,false)
 and not coalesce(hide_from_location_list,false) and station_code!~*'^HO(_|$)'
), valid as materialized (
 select distinct m.employee_id,s.station_code,m.kind,m.effective_from,
 case when m.effective_to='infinity'::date then null else m.effective_to end effective_to
 from mapped m join operating s on s.id=m.station_id
 where m.effective_from<=p_through and m.effective_to>=p_from and m.effective_from<=m.effective_to
)
select jsonb_build_object(
 'employees',coalesce((select jsonb_agg(e) from eligible e),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(v) from valid v),'[]'::jsonb),
 'stations',coalesce((select jsonb_agg(s) from operating s where exists(select 1 from valid v where v.station_code=s.station_code)),'[]'::jsonb),
 'salaries',coalesce((select jsonb_agg(t) from (
   select a.id,a.employee_id,a.effective_from,a.effective_to,max(v.amount) filter(where h.head_type='ctc') monthly_ctc
   from hr_employee_salary_assignments a
   left join hr_employee_salary_values v on v.assignment_id=a.id and v.company_id=p_company
   left join hr_payroll_heads h on h.id=v.payroll_head_id and h.company_id=p_company
   where a.company_id=p_company and a.employee_id in(select id from eligible)
   and a.effective_from<=p_through and coalesce(a.effective_to,p_through)>=p_from
   group by a.id,a.employee_id,a.effective_from,a.effective_to
 )t),'[]'::jsonb),
 'volumes',coalesce((select jsonb_agg(t) from (
   select station_code,work_date,sum(total_delivery) deliveries from cps_shipment_daily
   where company_id=p_company and work_date between p_from and p_through
   and station_code in(select station_code from valid)
   group by station_code,work_date
 )t),'[]'::jsonb)
);
$$;
revoke all on function public.ops_cps_people_assignments(uuid,date,date) from public,anon,authenticated;
grant execute on function public.ops_cps_people_assignments(uuid,date,date) to service_role;
