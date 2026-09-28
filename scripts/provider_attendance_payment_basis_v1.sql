begin;

set local lock_timeout = '15s';
set local statement_timeout = '60s';

create or replace function public.link_attendance_daily_workforce()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidates uuid[];
begin
  if new.workforce_id is null then
    with candidates as (
      select worker.id, worker.created_at,
        case
          when new.field_executive_id is not null and worker.id = new.field_executive_id then 1
          when new.employee_id is not null and worker.source_profile_type = 'employee' and worker.source_profile_id = new.employee_id then 2
          when new.contractor_id is not null and worker.source_profile_type = 'contractor' and worker.source_profile_id = new.contractor_id then 2
          when new.field_executive_id is not null and worker.source_profile_type = 'field_executive' and worker.source_profile_id = new.field_executive_id then 2
          else 3
        end as match_priority
      from public.workforce worker
      where worker.company_id = new.company_id
        and worker.deleted_at is null
        and worker.migration_state is distinct from 'reclassified'
        and (
          (new.employee_id is not null and worker.source_profile_type = 'employee' and worker.source_profile_id = new.employee_id)
          or (new.contractor_id is not null and worker.source_profile_type = 'contractor' and worker.source_profile_id = new.contractor_id)
          or (new.field_executive_id is not null and (worker.id = new.field_executive_id or (worker.source_profile_type = 'field_executive' and worker.source_profile_id = new.field_executive_id)))
          or (
            nullif(btrim(new.enrolment_id), '') is not null
            and nullif(btrim(worker.biometric_id), '') is not null
            and coalesce(nullif(ltrim(btrim(worker.biometric_id), '0'), ''), '0') = coalesce(nullif(ltrim(btrim(new.enrolment_id), '0'), ''), '0')
          )
        )
    )
    select array_agg(candidate.id order by candidate.created_at, candidate.id)
      into v_candidates
    from candidates candidate
    where candidate.match_priority = (select min(priority_candidate.match_priority) from candidates priority_candidate);
    if coalesce(array_length(v_candidates, 1), 0) = 1 then
      new.workforce_id := v_candidates[1];
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.link_attendance_daily_workforce() from public, anon, authenticated;

drop trigger if exists attendance_daily_00_workforce_identity on public.attendance_daily;
create trigger attendance_daily_00_workforce_identity
before insert or update of company_id, workforce_id, employee_id, contractor_id, field_executive_id, enrolment_id
on public.attendance_daily
for each row execute function public.link_attendance_daily_workforce();

with candidates as (
  select attendance.id as attendance_id, worker.id as workforce_id,
    case
      when attendance.field_executive_id is not null and worker.id = attendance.field_executive_id then 1
      when attendance.employee_id is not null and worker.source_profile_type = 'employee' and worker.source_profile_id = attendance.employee_id then 2
      when attendance.contractor_id is not null and worker.source_profile_type = 'contractor' and worker.source_profile_id = attendance.contractor_id then 2
      when attendance.field_executive_id is not null and worker.source_profile_type = 'field_executive' and worker.source_profile_id = attendance.field_executive_id then 2
      else 3
    end as match_priority
  from public.attendance_daily attendance
  join public.companies company
    on company.id = attendance.company_id
   and company.code = 'DROPX_LOGISTICS'
  join public.workforce worker
    on worker.company_id = attendance.company_id
   and worker.deleted_at is null
   and worker.migration_state is distinct from 'reclassified'
   and (
     (attendance.employee_id is not null and worker.source_profile_type = 'employee' and worker.source_profile_id = attendance.employee_id)
     or (attendance.contractor_id is not null and worker.source_profile_type = 'contractor' and worker.source_profile_id = attendance.contractor_id)
     or (attendance.field_executive_id is not null and (worker.id = attendance.field_executive_id or (worker.source_profile_type = 'field_executive' and worker.source_profile_id = attendance.field_executive_id)))
     or (
       nullif(btrim(attendance.enrolment_id), '') is not null
       and nullif(btrim(worker.biometric_id), '') is not null
       and coalesce(nullif(ltrim(btrim(worker.biometric_id), '0'), ''), '0') = coalesce(nullif(ltrim(btrim(attendance.enrolment_id), '0'), ''), '0')
     )
  )
  where attendance.workforce_id is null
), ranked as (
  select candidate.*,
    min(candidate.match_priority) over (partition by candidate.attendance_id) as best_priority
  from candidates candidate
), resolved as (
  select ranked.attendance_id, ranked.workforce_id,
    count(*) over (partition by ranked.attendance_id) as match_count
  from ranked
  where ranked.match_priority = ranked.best_priority
)
update public.attendance_daily attendance
set workforce_id = resolved.workforce_id
from resolved
where attendance.id = resolved.attendance_id
  and resolved.match_count = 1;

-- Provider-linked attendance is now supported by every payout engine. Keep the
-- existing trigger names and shared advisory lock so provider mappings, method
-- components and direct-allocation snapshots cannot race one another.
create or replace function public.enforce_attendance_payment_field_direct_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  return new;
end;
$$;

create or replace function public.enforce_provider_mapping_payment_basis()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  return new;
end;
$$;

create or replace function public.enforce_payment_component_provider_basis()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workforce-payment-basis:' || new.company_id::text, 0));
  return new;
end;
$$;

do $$
declare
  v_company_id uuid;
  v_target_count integer;
begin
  select company.id
    into strict v_company_id
  from public.companies company
  where company.code = 'DROPX_LOGISTICS';

  perform pg_advisory_xact_lock(
    hashtextextended('workforce-payment-basis:' || v_company_id::text, 0)
  );

  select count(*)
    into v_target_count
  from public.payment_fields field
  where field.company_id = v_company_id
    and field.code in (
      'FIXED_PAY_PER_DAY',
      'FIXED_PAY_PER_MONTH',
      'MG_PER_DAY',
      'MG_PER_MONTH',
      'VAN_RENT_PER_DAY',
      'VAN_RENT_PER_MONTH'
    );

  if v_target_count <> 6 then
    raise exception 'Expected exactly 6 DropX attendance payment fields; found %.', v_target_count;
  end if;

  if exists (
    select 1
    from public.payment_fields field
    where field.company_id = v_company_id
      and (
        (field.code in ('FIXED_PAY_PER_DAY', 'MG_PER_DAY', 'VAN_RENT_PER_DAY')
          and (field.field_type is distinct from 'amount' or field.pay_schedule is distinct from 'per_day'))
        or
        (field.code in ('FIXED_PAY_PER_MONTH', 'MG_PER_MONTH', 'VAN_RENT_PER_MONTH')
          and (field.field_type is distinct from 'amount' or field.pay_schedule is distinct from 'per_month'))
      )
  ) then
    raise exception 'A DropX attendance payment field has an unexpected type or schedule.';
  end if;

  update public.payment_fields field
  set calculation_source = 'attendance_eligibility',
      calculation_type = case
        when field.code in ('FIXED_PAY_PER_MONTH', 'MG_PER_MONTH', 'VAN_RENT_PER_MONTH')
          then 'fixed_monthly'
        else 'fixed_daily'
      end,
      provider_calculation_sources = '{}'::jsonb,
      updated_at = now()
  where field.company_id = v_company_id
    and field.code in (
      'FIXED_PAY_PER_DAY',
      'FIXED_PAY_PER_MONTH',
      'MG_PER_DAY',
      'MG_PER_MONTH',
      'VAN_RENT_PER_DAY',
      'VAN_RENT_PER_MONTH'
    )
    and (
      field.calculation_source is distinct from 'attendance_eligibility'
      or field.calculation_type is distinct from case
        when field.code in ('FIXED_PAY_PER_MONTH', 'MG_PER_MONTH', 'VAN_RENT_PER_MONTH')
          then 'fixed_monthly'
        else 'fixed_daily'
      end
      or field.provider_calculation_sources is distinct from '{}'::jsonb
    );

  if (
    select count(*)
    from public.payment_fields field
    where field.company_id = v_company_id
      and field.code in (
        'FIXED_PAY_PER_DAY',
        'FIXED_PAY_PER_MONTH',
        'MG_PER_DAY',
        'MG_PER_MONTH',
        'VAN_RENT_PER_DAY',
        'VAN_RENT_PER_MONTH'
      )
      and field.calculation_source = 'attendance_eligibility'
      and field.calculation_type = case
        when field.code in ('FIXED_PAY_PER_MONTH', 'MG_PER_MONTH', 'VAN_RENT_PER_MONTH')
          then 'fixed_monthly'
        else 'fixed_daily'
      end
  ) <> 6 then
    raise exception 'The six DropX payment fields were not fully converted to attendance.';
  end if;
end
$$;

commit;
