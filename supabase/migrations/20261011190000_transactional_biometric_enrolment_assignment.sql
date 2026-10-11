begin;

-- The original attendance schema only allowed Employees and the legacy Field
-- Executive shape. Category enrolments use account_id, so replace that check
-- before the transactional writer starts enforcing the canonical owner shape.
alter table public.biometric_enrolments
  drop constraint if exists biometric_enrolments_one_person_check;
alter table public.biometric_enrolments
  drop constraint if exists biometric_enrolments_owner_shape_check;
alter table public.biometric_enrolments
  add constraint biometric_enrolments_owner_shape_check check (
    (
      profile_type = 'employee'
      and worker_type = 'employee'
      and account_id is not null
      and employee_id = account_id
      and field_executive_id is null
    )
    or (
      profile_type = 'field_executive'
      and worker_type = 'individual_contract'
      and account_id is not null
      and field_executive_id = account_id
      and employee_id is null
    )
    or (
      profile_type in ('contractor', 'vendor', 'worker')
      and worker_type = 'individual_contract'
      and account_id is not null
      and employee_id is null
      and field_executive_id is null
    )
    or (
      -- Preserve old rows until they are touched by the synchronizer. New RPC
      -- writes always use one of the canonical shapes above.
      profile_type is null
      and (
        (worker_type = 'employee' and employee_id is not null and field_executive_id is null)
        or (worker_type = 'individual_contract' and field_executive_id is not null and employee_id is null)
      )
    )
  ) not valid;

alter table public.biometric_enrolments
  drop constraint if exists biometric_enrolments_effective_window_check;
alter table public.biometric_enrolments
  add constraint biometric_enrolments_effective_window_check check (
    effective_to is null or effective_to >= effective_from
  ) not valid;

-- Some installations still retain one of the pre-category unique indexes.
-- Those indexes incorrectly reject the intentionally grandfathered case where
-- different profile categories share one device number.
drop index if exists public.biometric_enrolments_company_enrolment_active_uidx;
drop index if exists public.biometric_enrolments_company_type_enrolment_active_uidx;
create unique index if not exists biometric_enrolments_company_profile_enrolment_active_uidx
  on public.biometric_enrolments(company_id, profile_type, enrolment_id)
  where effective_to is null;

drop function if exists public.replace_biometric_enrolment_assignment(jsonb, uuid, uuid[], date);

-- Replace a profile's biometric ownership window in one transaction. The
-- function accepts only an identity. It locks and rereads the master profile,
-- derives the biometric ID, owner columns, station, lifecycle status and dates,
-- and never trusts a caller-supplied row ID or close set.
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
  set status = 'Inactive',
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

-- The Helper payout freeze originally treated every enrolment change in a
-- company as Helper data. Narrow it to the affected Helper owner (or an ID
-- shared with that Helper) so an unrelated Employee/Workforce sync is not
-- blocked by a Helper bank batch.
create or replace function public.guard_helper_payout_period_source_processing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scopes jsonb := '[]'::jsonb;
  v_companies uuid[] := '{}'::uuid[];
  v_company uuid;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2],
      'profile_type', row_json ->> 'profile_type',
      'account_id', row_json ->> 'account_id',
      'enrolment_id', row_json ->> 'enrolment_id'
    )), '[]'::jsonb) into v_scopes
    from (select to_jsonb(row_data) row_json from helper_processing_new_rows row_data) changed;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2],
      'profile_type', row_json ->> 'profile_type',
      'account_id', row_json ->> 'account_id',
      'enrolment_id', row_json ->> 'enrolment_id'
    )), '[]'::jsonb) into v_scopes
    from (select to_jsonb(row_data) row_json from helper_processing_old_rows row_data) changed;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', row_json ->> tg_argv[0],
      'effective_from', row_json ->> tg_argv[1],
      'effective_to', row_json ->> tg_argv[2],
      'profile_type', row_json ->> 'profile_type',
      'account_id', row_json ->> 'account_id',
      'enrolment_id', row_json ->> 'enrolment_id'
    )), '[]'::jsonb) into v_scopes
    from (
      select to_jsonb(row_data) row_json from helper_processing_old_rows row_data
      union all
      select to_jsonb(row_data) row_json from helper_processing_new_rows row_data
    ) changed;
  end if;

  select coalesce(array_agg(distinct (scope.value ->> 'company_id')::uuid
    order by (scope.value ->> 'company_id')::uuid), '{}'::uuid[])
  into v_companies
  from jsonb_array_elements(v_scopes) scope(value)
  where nullif(scope.value ->> 'company_id', '') is not null
    and nullif(scope.value ->> 'effective_from', '') is not null;
  if cardinality(v_companies) = 0 then return null; end if;

  foreach v_company in array v_companies loop
    perform public.lock_workforce_payment_allocation_company(v_company);
  end loop;
  if exists (
    select 1
    from public.helper_payout_payment_items item
    join jsonb_array_elements(v_scopes) scope(value)
      on item.company_id = (scope.value ->> 'company_id')::uuid
     and daterange(item.period_start, item.period_end, '[]')
       && daterange(
         (scope.value ->> 'effective_from')::date,
         coalesce(nullif(scope.value ->> 'effective_to', '')::date, 'infinity'::date),
         '[]'
       )
    where item.status = 'processing'
      and (
        (
          pg_catalog.lower(coalesce(scope.value ->> 'profile_type', '')) = 'worker'
          and nullif(scope.value ->> 'account_id', '')::uuid = item.helper_id
        )
        or (
          public.normalize_people_biometric_id(scope.value ->> 'enrolment_id') is not null
          and exists (
            select 1
            from public.biometric_enrolments helper_mapping
            where helper_mapping.company_id = item.company_id
              and helper_mapping.profile_type = 'worker'
              and helper_mapping.account_id = item.helper_id
              and public.normalize_people_biometric_id(helper_mapping.enrolment_id)
                = public.normalize_people_biometric_id(scope.value ->> 'enrolment_id')
              and daterange(item.period_start, item.period_end, '[]')
                && daterange(
                  helper_mapping.effective_from,
                  coalesce(helper_mapping.effective_to, 'infinity'::date),
                  '[]'
                )
          )
        )
      )
  ) then
    raise exception 'Biometric or attendance data cannot change while an overlapping Helper payment is Processing.';
  end if;
  return null;
end;
$function$;

notify pgrst, 'reload schema';

commit;
