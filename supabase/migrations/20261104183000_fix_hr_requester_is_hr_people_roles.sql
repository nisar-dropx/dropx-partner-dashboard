-- WFH (and related) manager decide failed for National Head with:
--   relation "public.roles" does not exist
-- hr_requester_is_hr_people still joined the legacy public.roles table; portal
-- roles live in public.user_roles.
begin;

create or replace function public.hr_requester_is_hr_people(
  p_company_id uuid,
  p_profile_type text,
  p_profile_id uuid,
  p_designation_id uuid default null,
  p_requested_by uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_code text;
  v_name text;
  v_role_code text;
begin
  if p_designation_id is not null then
    select upper(replace(replace(coalesce(code, ''), '-', '_'), ' ', '_')),
           lower(regexp_replace(replace(coalesce(name, ''), '-', ' '), '\s+', ' ', 'g'))
      into v_code, v_name
    from public.designations
    where company_id = p_company_id and id = p_designation_id;
    if v_code in (
         'HR', 'HRM', 'HRE', 'HR_HEAD', 'HR_MANAGER', 'HR_EXECUTIVE',
         'PEOPLE_HRM', 'OPERATIONS_HRM', 'WORKFORCE_HRM', 'RECRUIT_HRM', 'PEOPLE_HEAD'
       )
       or v_name in ('hr', 'hr head', 'hr executive', 'hr manager')
       or v_name like '%hr head%'
       or v_name like '%hr executive%'
       or v_name like '%hr manager%'
       or v_name like '%human resource%'
       or v_name like '%people ops%'
       or v_name like '%people operations%' then
      return true;
    end if;
  end if;

  if p_profile_type = 'employee' and p_profile_id is not null then
    select upper(replace(replace(coalesce(d.code, ''), '-', '_'), ' ', '_')),
           lower(regexp_replace(replace(coalesce(d.name, ''), '-', ' '), '\s+', ' ', 'g'))
      into v_code, v_name
    from public.employees e
    join public.designations d on d.company_id = e.company_id and d.id = e.designation_id
    where e.company_id = p_company_id and e.id = p_profile_id and e.is_active;
    if v_code in (
         'HR', 'HRM', 'HRE', 'HR_HEAD', 'HR_MANAGER', 'HR_EXECUTIVE',
         'PEOPLE_HRM', 'OPERATIONS_HRM', 'WORKFORCE_HRM', 'RECRUIT_HRM', 'PEOPLE_HEAD'
       )
       or v_name in ('hr', 'hr head', 'hr executive', 'hr manager')
       or v_name like '%hr head%'
       or v_name like '%hr executive%'
       or v_name like '%hr manager%'
       or v_name like '%human resource%'
       or v_name like '%people ops%'
       or v_name like '%people operations%' then
      return true;
    end if;
  elsif p_profile_type = 'contractor' and p_profile_id is not null then
    select lower(regexp_replace(replace(coalesce(designation, ''), '-', ' '), '\s+', ' ', 'g'))
      into v_name
    from public.contractors
    where company_id = p_company_id and id = p_profile_id and is_active;
    if v_name in ('hr', 'hr head', 'hr executive', 'hr manager')
       or v_name like '%hr head%'
       or v_name like '%hr executive%'
       or v_name like '%hr manager%'
       or v_name like '%human resource%' then
      return true;
    end if;
  end if;

  if p_requested_by is not null then
    select upper(coalesce(r.code, '')) into v_role_code
    from public.profiles p
    join public.user_roles r on r.company_id = p.company_id and r.id = p.role_id
    where p.company_id = p_company_id and p.id = p_requested_by and p.is_active;
    if v_role_code in (
      'HR_HEAD', 'HR_HAEAD', 'HRM', 'HRE', 'HR_EXECUTIVE', 'HR_MANAGER',
      'PEOPLE_HRM', 'OPERATIONS_HRM', 'WORKFORCE_HRM', 'RECRUIT_HRM'
    ) then
      return true;
    end if;
  end if;

  return false;
end;
$function$;

revoke all on function public.hr_requester_is_hr_people(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_requester_is_hr_people(uuid, text, uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
