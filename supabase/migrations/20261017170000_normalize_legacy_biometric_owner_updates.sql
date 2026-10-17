begin;

-- The canonical assignment writer may need to close an older duplicate before
-- updating its chosen current row. Some pre-category Workforce rows retain the
-- legacy `profile_type = workforce` owner shape. The owner-shape constraint is
-- intentionally NOT VALID so those rows can remain readable, but PostgreSQL
-- still enforces it whenever such a row is updated. Canonicalize every row the
-- writer closes in the same statement; do not weaken or drop the constraint.
create or replace function public.replace_biometric_enrolment_assignment(
  p_company_id uuid,
  p_actor_id uuid,
  p_profile_type text,
  p_account_id uuid,
  p_fallback_location_id uuid default null
)
returns setof public.biometric_enrolments
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_assignment_date date := (pg_catalog.clock_timestamp() at time zone 'Asia/Kolkata')::date;
  v_effective_from date;
  v_employee_id uuid;
  v_enrolment_id text;
  v_field_executive_id uuid;
  v_has_prior_owner boolean := false;
  v_is_active boolean;
  v_joining_date date;
  v_location_id uuid;
  v_master_biometric_id text;
  v_master_count integer := 0;
  v_master_table text;
  v_prior_effective_to date;
  v_profile_type text;
  v_result public.biometric_enrolments%rowtype;
  v_status text;
  v_target public.biometric_enrolments%rowtype;
  v_target_id uuid;
  v_worker_type text;
begin
  if p_company_id is null or p_account_id is null then
    raise exception 'Company and profile are required for biometric enrolment.' using errcode = '22023';
  end if;

  v_profile_type := case pg_catalog.lower(pg_catalog.btrim(coalesce(p_profile_type, '')))
    when 'workforce' then 'field_executive'
    else pg_catalog.lower(pg_catalog.btrim(coalesce(p_profile_type, '')))
  end;
  if v_profile_type not in ('employee', 'field_executive', 'contractor', 'vendor', 'worker') then
    raise exception 'Biometric profile type is invalid.' using errcode = '22023';
  end if;

  -- Serialize every RPC mutation in a company. This covers concurrent claims
  -- for different spellings of the same numeric ID and ID swaps between people.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('biometric-enrolment-assignment:' || p_company_id::text, 0)
  );

  -- Lock the canonical master row and derive all assignment facts there. This
  -- prevents a service caller from forging owner columns or closing another
  -- person's mappings through a JSON payload.
  if v_profile_type = 'employee' then
    select profile.biometric_id, profile.location_id,
      coalesce(profile.is_active, true), profile.date_of_join
    into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
    from public.employees profile
    where profile.company_id = p_company_id and profile.id = p_account_id
    for update;
    if not found then
      raise exception 'Employee profile was not found in this company.' using errcode = 'P0002';
    end if;
    v_worker_type := 'employee';
    v_employee_id := p_account_id;
    v_field_executive_id := null;
    v_master_table := 'employees';
  elsif v_profile_type = 'field_executive' then
    select profile.biometric_id, profile.location_id,
      coalesce(profile.is_active, true), profile.date_of_join
    into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
    from public.workforce profile
    where profile.company_id = p_company_id and profile.id = p_account_id
    for update;
    if not found then
      raise exception 'Workforce profile was not found in this company.' using errcode = 'P0002';
    end if;
    v_worker_type := 'individual_contract';
    v_employee_id := null;
    v_field_executive_id := p_account_id;
    v_master_table := 'workforce';
  elsif v_profile_type = 'contractor' then
    select profile.biometric_id, profile.location_id,
      coalesce(profile.is_active, true), profile.date_of_join
    into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
    from public.contractors profile
    where profile.company_id = p_company_id and profile.id = p_account_id
    for update;
    if not found then
      raise exception 'Contractor profile was not found in this company.' using errcode = 'P0002';
    end if;
    v_worker_type := 'individual_contract';
    v_employee_id := null;
    v_field_executive_id := null;
    v_master_table := 'contractors';
  elsif v_profile_type = 'vendor' then
    select profile.biometric_id, profile.location_id,
      coalesce(profile.is_active, true), profile.date_of_join
    into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
    from public.vendors profile
    where profile.company_id = p_company_id and profile.id = p_account_id
    for update;
    if not found then
      raise exception 'Vendor profile was not found in this company.' using errcode = 'P0002';
    end if;
    v_worker_type := 'individual_contract';
    v_employee_id := null;
    v_field_executive_id := null;
    v_master_table := 'vendors';
  else
    -- The canonical Helpers register is preferred, while the two legacy
    -- registers remain readable for old device links until their migration is
    -- complete. More than one matching UUID is treated as ambiguous.
    select pg_catalog.count(*)::integer
    into v_master_count
    from (
      select 1 from public.helpers profile
        where profile.company_id = p_company_id and profile.id = p_account_id
      union all
      select 1 from public.workforce_helpers profile
        where profile.company_id = p_company_id and profile.id = p_account_id
      union all
      select 1 from public.workforce_pickers profile
        where profile.company_id = p_company_id and profile.id = p_account_id
    ) matches;
    if v_master_count <> 1 then
      raise exception 'Helper profile was not found uniquely in this company.' using errcode = 'P0002';
    end if;

    if exists (
      select 1 from public.helpers profile
      where profile.company_id = p_company_id and profile.id = p_account_id
    ) then
      select profile.biometric_id, profile.location_id,
        coalesce(profile.is_active, true), profile.date_of_join
      into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
      from public.helpers profile
      where profile.company_id = p_company_id and profile.id = p_account_id
      for update;
      v_master_table := 'helpers';
    elsif exists (
      select 1 from public.workforce_helpers profile
      where profile.company_id = p_company_id and profile.id = p_account_id
    ) then
      select profile.biometric_id, profile.location_id,
        coalesce(profile.is_active, true), profile.date_of_join
      into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
      from public.workforce_helpers profile
      where profile.company_id = p_company_id and profile.id = p_account_id
      for update;
      v_master_table := 'workforce_helpers';
    else
      select profile.biometric_id, profile.location_id,
        coalesce(profile.is_active, true), profile.date_of_join
      into v_master_biometric_id, v_location_id, v_is_active, v_joining_date
      from public.workforce_pickers profile
      where profile.company_id = p_company_id and profile.id = p_account_id
      for update;
      v_master_table := 'workforce_pickers';
    end if;
    v_worker_type := 'individual_contract';
    v_employee_id := null;
    v_field_executive_id := null;
  end if;

  v_master_biometric_id := nullif(pg_catalog.btrim(v_master_biometric_id), '');
  v_enrolment_id := public.normalize_people_biometric_id(v_master_biometric_id);
  if v_master_biometric_id is not null and v_enrolment_id is null then
    raise exception 'Biometric ID must contain 1 to 20 digits only.' using errcode = '22023';
  end if;

  v_location_id := coalesce(v_location_id, p_fallback_location_id);
  if v_enrolment_id is not null and (
    v_location_id is null or not exists (
      select 1 from public.stations station
      where station.company_id = p_company_id and station.id = v_location_id
    )
  ) then
    raise exception 'A station in the profile company is required for biometric enrolment.' using errcode = '23503';
  end if;
  v_status := case when v_is_active then 'Active' else 'Inactive' end;
  v_prior_effective_to := v_assignment_date - 1;

  -- Lock every enrolment row that can influence the decision. The advisory
  -- lock serializes this RPC; row locks also serialize with legacy direct writers.
  perform 1
  from public.biometric_enrolments be
  where be.company_id = p_company_id
    and (
      (
        (case
          when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
          when be.profile_type is not null then be.profile_type
          when be.worker_type = 'employee' then 'employee'
          else 'contractor'
        end) = v_profile_type
        and (case
          when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
            then coalesce(be.employee_id, be.account_id)
          when be.profile_type in ('field_executive', 'workforce')
            then coalesce(be.field_executive_id, be.account_id)
          else coalesce(be.account_id, be.employee_id, be.field_executive_id)
        end) = p_account_id
      )
      or (
        v_enrolment_id is not null
        and public.normalize_people_biometric_id(be.enrolment_id) = v_enrolment_id
      )
    )
  for update;

  select exists (
    select 1
    from public.biometric_enrolments be
    where be.company_id = p_company_id
      and (case
        when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
        when be.profile_type is not null then be.profile_type
        when be.worker_type = 'employee' then 'employee'
        else 'contractor'
      end) = v_profile_type
      and (case
        when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
          then coalesce(be.employee_id, be.account_id)
        when be.profile_type in ('field_executive', 'workforce')
          then coalesce(be.field_executive_id, be.account_id)
        else coalesce(be.account_id, be.employee_id, be.field_executive_id)
      end) = p_account_id
  ) into v_has_prior_owner;

  if v_enrolment_id is not null then
    select be.*
    into v_target
    from public.biometric_enrolments be
    where be.company_id = p_company_id
      and be.effective_to is null
      and public.normalize_people_biometric_id(be.enrolment_id) = v_enrolment_id
      and be.location_id is not distinct from v_location_id
      and (case
        when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
        when be.profile_type is not null then be.profile_type
        when be.worker_type = 'employee' then 'employee'
        else 'contractor'
      end) = v_profile_type
      and (case
        when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
          then coalesce(be.employee_id, be.account_id)
        when be.profile_type in ('field_executive', 'workforce')
          then coalesce(be.field_executive_id, be.account_id)
        else coalesce(be.account_id, be.employee_id, be.field_executive_id)
      end) = p_account_id
    order by
      case when be.profile_type = v_profile_type then 0 else 1 end,
      case when be.enrolment_id = v_enrolment_id then 0 else 1 end,
      pg_catalog.length(be.enrolment_id),
      be.id
    limit 1;
    if found then v_target_id := v_target.id; end if;
  end if;

  v_effective_from := case
    when v_target_id is not null then v_target.effective_from
    when v_has_prior_owner then v_assignment_date
    else coalesce(v_joining_date, v_assignment_date)
  end;

  -- Cross-category sharing is grandfathered and resolved by the attendance
  -- priority policy. A second owner in the same semantic category is never safe.
  if v_enrolment_id is not null and exists (
    select 1
    from public.biometric_enrolments be
    where be.company_id = p_company_id
      and be.id is distinct from v_target_id
      and public.normalize_people_biometric_id(be.enrolment_id) = v_enrolment_id
      and (case
        when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
        when be.profile_type is not null then be.profile_type
        when be.worker_type = 'employee' then 'employee'
        else 'contractor'
      end) = v_profile_type
      and (case
        when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
          then coalesce(be.employee_id, be.account_id)
        when be.profile_type in ('field_executive', 'workforce')
          then coalesce(be.field_executive_id, be.account_id)
        else coalesce(be.account_id, be.employee_id, be.field_executive_id)
      end) is distinct from p_account_id
      and (
        be.effective_to is null
        or (v_target_id is null and be.effective_to >= v_effective_from)
      )
  ) then
    raise exception 'Biometric enrolment ID % is already assigned to another worker in this category.', v_enrolment_id using errcode = '23505';
  end if;

  -- Inclusive ownership windows cannot express two assignments on one day.
  -- Close only this owner; caller-supplied IDs can never truncate another
  -- category or person's history.
  if exists (
    select 1
    from public.biometric_enrolments be
    where be.company_id = p_company_id
      and be.id is distinct from v_target_id
      and (case
        when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
        when be.profile_type is not null then be.profile_type
        when be.worker_type = 'employee' then 'employee'
        else 'contractor'
      end) = v_profile_type
      and (case
        when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
          then coalesce(be.employee_id, be.account_id)
        when be.profile_type in ('field_executive', 'workforce')
          then coalesce(be.field_executive_id, be.account_id)
        else coalesce(be.account_id, be.employee_id, be.field_executive_id)
      end) = p_account_id
      and (
        be.effective_to is null
        or (be.effective_from <= v_assignment_date and be.effective_to >= v_assignment_date)
      )
      and be.effective_from > v_prior_effective_to
  ) then
    raise exception 'Biometric enrolment cannot be reassigned more than once on the same date.' using errcode = '22023';
  end if;

  update public.biometric_enrolments be
  set worker_type = v_worker_type,
      profile_type = v_profile_type,
      account_id = p_account_id,
      employee_id = v_employee_id,
      field_executive_id = v_field_executive_id,
      status = 'Inactive',
      effective_to = v_prior_effective_to,
      updated_at = pg_catalog.clock_timestamp()
  where be.company_id = p_company_id
    and be.id is distinct from v_target_id
    and (case
      when be.profile_type in ('field_executive', 'workforce') then 'field_executive'
      when be.profile_type is not null then be.profile_type
      when be.worker_type = 'employee' then 'employee'
      else 'contractor'
    end) = v_profile_type
    and (case
      when coalesce(nullif(be.profile_type, ''), case when be.worker_type = 'employee' then 'employee' else 'contractor' end) = 'employee'
        then coalesce(be.employee_id, be.account_id)
      when be.profile_type in ('field_executive', 'workforce')
        then coalesce(be.field_executive_id, be.account_id)
      else coalesce(be.account_id, be.employee_id, be.field_executive_id)
    end) = p_account_id
    and (
      be.effective_to is null
      or (be.effective_from <= v_assignment_date and be.effective_to >= v_assignment_date)
    );

  if v_enrolment_id is null then
    return;
  end if;

  if v_target_id is not null then
    update public.biometric_enrolments be
    set enrolment_id = v_enrolment_id,
        worker_type = v_worker_type,
        profile_type = v_profile_type,
        account_id = p_account_id,
        employee_id = v_employee_id,
        field_executive_id = v_field_executive_id,
        location_id = v_location_id,
        status = v_status,
        effective_from = v_target.effective_from,
        effective_to = null,
        notes = coalesce(be.notes, 'Synchronized from ' || v_master_table || ' master.'),
        created_by = coalesce(be.created_by, p_actor_id),
        updated_at = pg_catalog.clock_timestamp()
    where be.company_id = p_company_id and be.id = v_target_id
    returning be.* into v_result;
  else
    insert into public.biometric_enrolments (
      company_id, enrolment_id, worker_type, profile_type, account_id,
      employee_id, field_executive_id, location_id, status, effective_from,
      effective_to, notes, created_by, updated_at
    ) values (
      p_company_id, v_enrolment_id, v_worker_type, v_profile_type, p_account_id,
      v_employee_id, v_field_executive_id, v_location_id, v_status, v_effective_from,
      null, 'Synchronized from ' || v_master_table || ' master.', p_actor_id,
      pg_catalog.clock_timestamp()
    )
    returning * into v_result;
  end if;

  return next v_result;
  return;
end;
$function$;

revoke all on function public.replace_biometric_enrolment_assignment(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.replace_biometric_enrolment_assignment(uuid, uuid, text, uuid, uuid)
  to service_role;

comment on function public.replace_biometric_enrolment_assignment(uuid, uuid, text, uuid, uuid) is
  'Atomically replaces one canonical biometric assignment and normalizes any grandfathered same-owner rows it closes.';

notify pgrst, 'reload schema';

commit;
