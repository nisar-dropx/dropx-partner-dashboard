begin;

-- Field Operations is an operational classification. Payment ownership is
-- controlled independently by provider_mapping_required.
alter table public.designations
  drop constraint if exists designations_provider_mapping_required_check;

comment on column public.designations.provider_mapping_required is
  'When true, workers assigned to this active designation require provider ID mapping. When false, they use direct workforce payment allocation. This policy is independent of Field Operations classification.';

alter table public.workforce_payment_policy_history
  drop constraint if exists workforce_payment_policy_history_policy_check;
alter table public.workforce_payment_policy_history
  add constraint workforce_payment_policy_history_policy_check
  check (not provider_mapping_required or designation_is_active);

create or replace function public.guard_designation_direct_payment_policy()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.provider_mapping_required = true and old.provider_mapping_required = false)
    or (new.is_active = false and old.is_active = true) then
    if exists (
      select 1
      from public.workforce_payment_allocations allocation
      join public.workforce workforce
        on workforce.id = allocation.workforce_id
       and workforce.company_id = allocation.company_id
      where workforce.company_id = new.company_id
        and (
          allocation.designation_id = new.id
          or workforce.designation_id = new.id
          or (workforce.designation_id is null and lower(btrim(workforce.designation)) in (lower(btrim(new.code)), lower(btrim(new.name))))
        )
        and allocation.status <> 'cancelled'
        and (allocation.effective_to is null or allocation.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
    ) then
      raise exception 'Close active direct payment allocations before requiring provider mapping or deactivating this designation.';
    end if;
  end if;
  return new;
end;
$$;

-- Patch only the obsolete Field Operations predicates in the authoritative
-- functions. Each replacement is guarded so schema drift fails the script
-- instead of silently leaving a mixed payment policy behind.
do $migration$
declare
  v_before text;
  v_after text;
begin
  v_before := pg_get_functiondef(
    'public.save_workforce_payment_allocation(uuid,uuid,uuid,jsonb,date,date,text,uuid)'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');
  if position(E'\n    and designation.is_field_operations = true' in v_after) = 0 then
    raise exception 'Unable to decouple save_workforce_payment_allocation from Field Operations.';
  end if;
  v_after := replace(v_after, E'\n    and designation.is_field_operations = true', '');
  execute v_after;

  v_before := pg_get_functiondef(
    'public.capture_workforce_payment_policy(uuid,date,uuid,text)'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');
  if position('v_provider_mapping_required:=v_is_field_operations and coalesce(v_designation.provider_mapping_required,false);' in v_after) = 0 then
    raise exception 'Unable to decouple workforce payment policy history from Field Operations.';
  end if;
  v_after := replace(
    v_after,
    'v_provider_mapping_required:=v_is_field_operations and coalesce(v_designation.provider_mapping_required,false);',
    'v_provider_mapping_required:=v_designation_is_active and coalesce(v_designation.provider_mapping_required,false);'
  );
  execute v_after;

  v_before := pg_get_functiondef(
    'public.reconcile_workforce_direct_payment_transition()'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');
  if position(E'v_new_direct_eligible := v_new_designation.is_field_operations = true\n    and v_new_designation.provider_mapping_required = false;' in v_after) = 0 then
    raise exception 'Unable to decouple workforce direct-payment transitions from Field Operations.';
  end if;
  v_after := replace(
    v_after,
    E'v_new_direct_eligible := v_new_designation.is_field_operations = true\n    and v_new_designation.provider_mapping_required = false;',
    'v_new_direct_eligible := v_new_designation.provider_mapping_required = false;'
  );
  v_after := replace(
    v_after,
    'Automatically cancelled before a provider-required or non-Field-Operations designation took effect.',
    'Automatically cancelled before a provider-required designation took effect.'
  );
  v_after := replace(
    v_after,
    'Automatically closed before a provider-required or non-Field-Operations designation took effect.',
    'Automatically closed before a provider-required designation took effect.'
  );
  execute v_after;

  v_before := pg_get_functiondef(
    'public.workforce_rebase_payment_policy_location(uuid,uuid,uuid,uuid,date)'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');
  if position(E'coalesce(designation.is_active, false)\n          and coalesce(designation.is_field_operations, false)\n          and coalesce(designation.provider_mapping_required, false)' in v_after) = 0 then
    raise exception 'Unable to decouple provider-mapping policy rebasing from Field Operations.';
  end if;
  v_after := replace(
    v_after,
    E'coalesce(designation.is_active, false)\n          and coalesce(designation.is_field_operations, false)\n          and coalesce(designation.provider_mapping_required, false)',
    E'coalesce(designation.is_active, false)\n          and coalesce(designation.provider_mapping_required, false)'
  );
  execute v_after;

  v_before := pg_get_functiondef(
    'public.ops_cps_source_facts(uuid,date,date,text[])'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');
  if position('(coalesce(designation.is_active,false) and coalesce(designation.is_field_operations,false) and coalesce(designation.provider_mapping_required,true)) as provider_mapping_required' in v_after) = 0 then
    raise exception 'Unable to decouple CPS provider-mapping policy facts from Field Operations.';
  end if;
  v_after := replace(
    v_after,
    '(coalesce(designation.is_active,false) and coalesce(designation.is_field_operations,false) and coalesce(designation.provider_mapping_required,true)) as provider_mapping_required',
    '(coalesce(designation.is_active,false) and coalesce(designation.provider_mapping_required,true)) as provider_mapping_required'
  );
  if position(E'\n           and policy.is_field_operations' in v_after) = 0 then
    raise exception 'Unable to decouple CPS employee ownership from Field Operations.';
  end if;
  v_after := replace(v_after, E'\n           and policy.is_field_operations', '');
  execute v_after;
end
$migration$;

commit;
