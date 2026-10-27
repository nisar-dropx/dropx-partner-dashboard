-- Physical-audit key custodians are often independent contractors (SSA, TL, SM)
-- mapped to the station. The directory previously listed only employees and
-- workforce, so stations like PHN showed only the visiting AOM while station
-- SSAs (e.g. Mihir) never appeared in "Choose UTR staff".

create or replace function public.station_audit_employee_directory(p_company uuid, p_station uuid)
returns table(ref text, employee_code text, full_name text, designation text, is_active boolean)
language sql
stable
set search_path to 'public'
as $function$
select 'employee:'||e.id, e.employee_code, e.full_name, coalesce(d.name, 'People'), e.is_active
from employees e
left join designations d on d.id = e.designation_id and d.company_id = p_company
where e.company_id = p_company
  and e.deleted_at is null
  and nullif(e.employee_code, '') is not null
  and (
    e.location_id = p_station
    or exists (
      select 1
      from hr_engagements g
      join hr_work_assignments a
        on a.engagement_id = g.id
       and a.company_id = p_company
      where g.company_id = p_company
        and g.employee_id = e.id
        and g.start_date <= current_date
        and coalesce(g.end_date, current_date) >= current_date
        and a.effective_from <= current_date
        and coalesce(a.effective_to, current_date) >= current_date
        and (
          a.location_id = p_station
          or exists (
            select 1
            from station_responsibility_assignments r
            where r.company_id = p_company
              and r.station_id = p_station
              and r.effective_from <= now()
              and coalesce(r.effective_to, now()) >= now()
              and (
                r.assignment_id = a.id
                or exists (
                  select 1
                  from hr_user_person_links l
                  where l.company_id = p_company
                    and l.person_id = g.person_id
                    and l.user_id = r.assignee_user_id
                    and l.status = 'active'
                )
              )
          )
        )
    )
    or exists (
      select 1
      from profiles p
      join station_responsibility_assignments r
        on r.assignee_user_id = p.id
       and r.company_id = p_company
      where p.company_id = p_company
        and (p.employee_id = e.id::text or p.employee_id = e.employee_code)
        and r.station_id = p_station
        and r.effective_from <= now()
        and coalesce(r.effective_to, now()) >= now()
    )
  )
union all
select 'contractor:'||c.id, c.dropx_id, c.full_name, coalesce(nullif(btrim(c.designation), ''), 'Contractor'), c.is_active
from contractors c
where c.company_id = p_company
  and c.deleted_at is null
  and nullif(c.dropx_id, '') is not null
  and (
    c.location_id = p_station
    or exists (
      select 1
      from hr_engagements g
      join hr_work_assignments a
        on a.engagement_id = g.id
       and a.company_id = p_company
      where g.company_id = p_company
        and g.contractor_id = c.id
        and g.start_date <= current_date
        and coalesce(g.end_date, current_date) >= current_date
        and a.effective_from <= current_date
        and coalesce(a.effective_to, current_date) >= current_date
        and (
          a.location_id = p_station
          or exists (
            select 1
            from station_responsibility_assignments r
            where r.company_id = p_company
              and r.station_id = p_station
              and r.effective_from <= now()
              and coalesce(r.effective_to, now()) >= now()
              and (
                r.assignment_id = a.id
                or exists (
                  select 1
                  from hr_user_person_links l
                  where l.company_id = p_company
                    and l.person_id = g.person_id
                    and l.user_id = r.assignee_user_id
                    and l.status = 'active'
                )
              )
          )
        )
    )
    or exists (
      select 1
      from profiles p
      join station_responsibility_assignments r
        on r.assignee_user_id = p.id
       and r.company_id = p_company
      where p.company_id = p_company
        and (p.employee_id = c.id::text or p.employee_id = c.dropx_id)
        and r.station_id = p_station
        and r.effective_from <= now()
        and coalesce(r.effective_to, now()) >= now()
    )
  )
union all
select 'workforce:'||w.id, w.dropx_id, w.full_name, coalesce(w.designation, 'Workforce'), w.is_active
from workforce w
where w.company_id = p_company
  and w.location_id = p_station
  and w.deleted_at is null
  and nullif(w.dropx_id, '') is not null
order by full_name, employee_code;
$function$;

revoke all on function public.station_audit_employee_directory(uuid, uuid) from public, anon, authenticated;
grant execute on function public.station_audit_employee_directory(uuid, uuid) to service_role;
