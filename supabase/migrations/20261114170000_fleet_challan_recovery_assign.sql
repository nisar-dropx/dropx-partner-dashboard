-- Assign/split a challan recovery across associates (equal or custom), with installments.
-- One DB function owns the state change and writes an audit row, per the workflow ground rules.

begin;

create or replace function public.fleet_challan_recovery_assign_v1(
  p_company uuid, p_case uuid, p_user uuid, p_name text,
  p_split_mode text, p_allocations jsonb, p_remarks text default null
) returns public.fleet_challan_recovery_cases
language plpgsql
security invoker
set search_path = public
as $$
declare
  k public.fleet_challan_recovery_cases;
  saved public.fleet_challan_recovery_cases;
  v_name text := coalesce(nullif(btrim(p_name),''),'Fleet user');
  v_a jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_mode text := lower(coalesce(nullif(btrim(p_split_mode),''),'custom'));
begin
  select * into k from public.fleet_challan_recovery_cases where company_id = p_company and id = p_case for update;
  if not found then raise exception 'Challan recovery case was not found.'; end if;
  if k.status in ('recovered','closed','cancelled') then
    raise exception 'This recovery case is %, so it cannot be reassigned.', k.status;
  end if;
  if v_mode not in ('equal','custom') then raise exception 'Split mode must be equal or custom.'; end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Add at least one associate to recover from.';
  end if;

  -- Validate every allocation and total.
  for v_a in select value from jsonb_array_elements(p_allocations) loop
    if nullif(btrim(v_a->>'ref'),'') is null then raise exception 'Each allocation needs an associate ref.'; end if;
    if split_part(v_a->>'ref',':',1) not in ('employee','contractor','workforce') then
      raise exception 'Unsupported associate ref %.', v_a->>'ref';
    end if;
    if nullif(btrim(v_a->>'salary_month'),'') is null or (v_a->>'salary_month') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
      raise exception 'Each allocation needs a valid salary month (YYYY-MM).';
    end if;
    if coalesce((v_a->>'amount')::numeric,0) <= 0 then raise exception 'Each allocation amount must be greater than zero.'; end if;
    v_total := v_total + round((v_a->>'amount')::numeric,2);
    v_count := v_count + 1;
  end loop;

  if round(v_total,2) > round(k.amount,2) then
    raise exception 'Split total (%) exceeds the challan amount (%).', v_total, k.amount;
  end if;

  -- Replace the allocation set for this case.
  delete from public.fleet_challan_recovery_allocations where company_id = p_company and case_id = p_case;
  insert into public.fleet_challan_recovery_allocations(
    company_id, case_id, person_ref, person_name, utr, split_mode, amount, salary_month,
    installment_no, installment_count, status, remarks, updated_by, updated_by_name
  )
  select
    p_company, p_case, ja->>'ref', coalesce(ja->>'name',''), coalesce(ja->>'utr',''), v_mode,
    round((ja->>'amount')::numeric,2), ja->>'salary_month',
    coalesce((ja->>'installment_no')::int,1), coalesce((ja->>'installment_count')::int,1),
    'planned', coalesce(ja->>'remarks',''), p_user, v_name
  from jsonb_array_elements(p_allocations) ja;

  update public.fleet_challan_recovery_cases set
    status = 'assigned',
    updated_at = now()
  where id = p_case
  returning * into saved;

  insert into public.fleet_challan_recovery_events(company_id, case_id, action, before_value, after_value, actor_id, actor_name)
  values (p_company, p_case, 'assign',
    jsonb_build_object('status', k.status),
    jsonb_build_object('split_mode', v_mode, 'count', v_count, 'total', v_total, 'remarks', p_remarks),
    p_user, v_name);

  return saved;
end;
$$;

revoke all on function public.fleet_challan_recovery_assign_v1(uuid, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.fleet_challan_recovery_assign_v1(uuid, uuid, uuid, text, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';
commit;
