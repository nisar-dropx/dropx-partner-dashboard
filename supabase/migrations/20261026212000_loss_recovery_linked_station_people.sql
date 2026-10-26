begin;
-- Recovery alone shares the parent EDSP/XPT team. Case access remains station-scoped.
-- Keep the audit directory unchanged: it serves unrelated audit workflows.
create or replace function public.nl_recovery_employee_directory(p_company uuid,p_station uuid)
returns table(ref text,employee_code text,full_name text,designation text,is_active boolean,locations text)
language sql stable security invoker set search_path=public as $$
with recursive
anchor as (
 select case when upper(m.code)='XPT' and parent.id is not null then parent.id else s.id end id
 from stations s left join location_models m on m.id=s.location_model_id
 left join stations parent on parent.id=s.parent_station_id and parent.company_id=p_company
 where s.company_id=p_company and s.id=p_station
), team as (
 select s.id,s.station_code,s.station_name from stations s join anchor a on s.id=a.id where s.company_id=p_company
 union
 select s.id,s.station_code,s.station_name from stations s join anchor a on s.parent_station_id=a.id
 join location_models m on m.id=s.location_model_id and upper(m.code)='XPT'
 where s.company_id=p_company
), active_assignments as (
 select a.id,a.location_id,a.designation_id,a.position_title,g.person_id,g.employee_id
 from hr_work_assignments a join hr_engagements g on g.id=a.engagement_id and g.company_id=p_company
 join hr_people p on p.id=g.person_id and p.company_id=p_company and p.status='active'
 where a.company_id=p_company and a.is_primary and g.status='active'
 and g.start_date<=(now() at time zone 'Asia/Kolkata')::date and coalesce(g.end_date,'infinity'::date)>=(now() at time zone 'Asia/Kolkata')::date
 and a.effective_from<=(now() at time zone 'Asia/Kolkata')::date and coalesce(a.effective_to,'infinity'::date)>=(now() at time zone 'Asia/Kolkata')::date
), explicit_roots as (
 -- Resolve historical assignment references to the person's current assignment.
 select distinct t.id station_id,a.id assignment_id
 from team t join station_responsibility_assignments r on r.station_id=t.id and r.company_id=p_company
 join station_responsibility_roles role on role.id=r.responsibility_role_id and role.company_id=p_company and role.is_active and role.owning_product_code='operations'
 left join hr_work_assignments old_a on old_a.id=r.assignment_id and old_a.company_id=p_company
 left join hr_engagements old_g on old_g.id=old_a.engagement_id and old_g.company_id=p_company
 join active_assignments a on a.person_id=old_g.person_id or exists(
  select 1 from hr_user_person_links l where l.company_id=p_company and l.person_id=a.person_id and l.user_id=r.assignee_user_id and l.status='active')
 where r.is_primary and r.effective_from<=now() and coalesce(r.effective_to,'infinity'::timestamptz)>=now()
), roots as (
 select * from explicit_roots
 union
 select t.id,a.id from team t join active_assignments a on a.location_id=t.id
 where not exists(select 1 from explicit_roots r where r.station_id=t.id)
), edges as (
 select distinct on (r.subject_assignment_id) r.subject_assignment_id,r.manager_assignment_id
 from hr_reporting_relationships r where r.company_id=p_company and r.is_primary and r.relationship_type='solid_line'
 and r.effective_from<=(now() at time zone 'Asia/Kolkata')::date and coalesce(r.effective_to,'infinity'::date)>=(now() at time zone 'Asia/Kolkata')::date
 order by r.subject_assignment_id,r.effective_from desc,r.id
), chain(station_id,assignment_id,path) as (
 select r.station_id,r.assignment_id,array[r.assignment_id] from roots r
 union all
 select c.station_id,a.id,c.path||a.id from chain c join edges e on e.subject_assignment_id=c.assignment_id
 join active_assignments a on a.id=e.manager_assignment_id
 where cardinality(c.path)<17 and not a.id=any(c.path)
), members as (
 select d.*,t.station_code||coalesce(' · '||nullif(t.station_name,''),'') location_label
 from team t cross join lateral station_audit_employee_directory(p_company,t.id) d
 union all
 select 'employee:'||e.id,e.employee_code,e.full_name,coalesce(d.name,a.position_title,'People'),e.is_active,
 t.station_code||coalesce(' · '||nullif(t.station_name,''),'')
 from chain c join active_assignments a on a.id=c.assignment_id join team t on t.id=c.station_id
 left join designations d on d.id=a.designation_id and d.company_id=p_company
 join employees e on e.company_id=p_company and (e.id=a.employee_id or exists(
   select 1 from hr_user_person_links l join profiles p on p.id=l.user_id and p.company_id=p_company
   where l.company_id=p_company and l.person_id=a.person_id and l.status='active' and (p.employee_id=e.id::text or p.employee_id=e.employee_code)))
 where e.deleted_at is null and nullif(e.employee_code,'') is not null
 and (upper(coalesce(d.code,'')) in ('CLM','CM','AOM') or upper(concat_ws(' ',d.name,a.position_title)) ~ '(CLUSTER (MANAGER|HEAD)|AREA OPERATIONS? MANAGER)')
)
select m.ref,max(m.employee_code),max(m.full_name),max(m.designation),bool_or(m.is_active),string_agg(distinct m.location_label,' / ' order by m.location_label)
from members m group by m.ref order by max(m.full_name),max(m.employee_code),m.ref;
$$;
revoke all on function public.nl_recovery_employee_directory(uuid,uuid) from public,anon,authenticated;
grant execute on function public.nl_recovery_employee_directory(uuid,uuid) to service_role;

-- The database must validate exactly the directory offered by the picker/workbook.
do $$ declare f record; definition text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  definition:=pg_get_functiondef(f.oid);
  if position('nl_recovery_employee_directory(p_company,station)' in definition)>0 then patched:=true; continue; end if;
  if position('station_audit_employee_directory(p_company,station)' in definition)>0 then
   definition:=replace(definition,'station_audit_employee_directory(p_company,station)','nl_recovery_employee_directory(p_company,station)');
   execute definition; patched:=true;
  end if;
 end loop;
 if not patched then raise exception 'Recovery directory validation patch failed'; end if;
end $$;
commit;
