-- Expense / approval routing requires profiles.is_active. Some active workers
-- kept an hr_user_person_links row while their portal profile was flipped off
-- (Workspace revoke or bulk access jobs), which blocked expense pre-requests
-- with "The reporting manager must have an active login in this company."

begin;

update public.profiles profile
set is_active = true,
    updated_at = now()
where coalesce(profile.is_active, false) = false
  and exists (
    select 1
    from public.hr_user_person_links link
    join public.hr_engagements engagement
      on engagement.company_id = link.company_id
     and engagement.person_id = link.person_id
     and engagement.status = 'active'
    join public.hr_people person
      on person.company_id = engagement.company_id
     and person.id = engagement.person_id
     and person.status = 'active'
    where link.company_id = profile.company_id
      and link.user_id = profile.id
      and link.status = 'active'
      and (
        exists (
          select 1 from public.employees employee
          where employee.company_id = engagement.company_id
            and employee.id = engagement.employee_id
            and employee.is_active
        )
        or exists (
          select 1 from public.contractors contractor
          where contractor.company_id = engagement.company_id
            and contractor.id = engagement.contractor_id
            and contractor.is_active
        )
      )
  );

commit;
