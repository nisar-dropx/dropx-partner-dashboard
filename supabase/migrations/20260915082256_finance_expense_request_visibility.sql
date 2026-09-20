begin;

alter table public.hr_expense_categories
  add column if not exists show_in_expense_requests boolean not null default true;
comment on column public.hr_expense_categories.show_in_expense_requests is
  'Finance-controlled visibility for trip estimates in DropX One. Independent of receipt-claim eligibility and category activation.';

CREATE OR REPLACE FUNCTION public.finance_save_reimbursement_master(p_company uuid, p_actor uuid, p_kind text, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid := nullif(p_data->>'id','')::uuid; v_before jsonb; v_after jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company and is_active) then
    raise exception 'Active Finance editor is required.';
  end if;
  if p_kind='head' then
    if p_data ? 'show_in_expense_requests' and jsonb_typeof(p_data->'show_in_expense_requests') <> 'boolean' then
      raise exception 'Expense request visibility must be true or false.';
    end if;
    if length(trim(p_data->>'name')) < 2 or coalesce(p_data->>'code','') !~ '^[A-Z][A-Z0-9_]{1,39}$' then
      raise exception 'Enter a valid head code and name.';
    end if;
    if v_id is not null then
      select to_jsonb(t) into v_before from public.hr_expense_categories t where company_id=p_company and id=v_id for update;
      if v_before is null then raise exception 'Expense head not found.'; end if;
      if v_before->>'updated_at' is distinct from p_data->>'expected_updated_at' then raise exception 'Record changed. Refresh before saving.'; end if;
      update public.hr_expense_categories set name=trim(p_data->>'name'),description=nullif(trim(p_data->>'description'),''),
        receipt_required=(p_data->>'receipt_required')::boolean,receipt_threshold=(p_data->>'receipt_threshold')::numeric,
        show_in_expense_requests=coalesce((p_data->>'show_in_expense_requests')::boolean,show_in_expense_requests),
        is_active=(p_data->>'is_active')::boolean,updated_by=p_actor,updated_at=clock_timestamp()
        where company_id=p_company and id=v_id;
    else
      insert into public.hr_expense_categories(company_id,code,name,description,receipt_required,receipt_threshold,is_active,show_in_expense_requests,created_by,updated_by)
      values(p_company,p_data->>'code',trim(p_data->>'name'),nullif(trim(p_data->>'description'),''),
        (p_data->>'receipt_required')::boolean,(p_data->>'receipt_threshold')::numeric,coalesce((p_data->>'is_active')::boolean,true),coalesce((p_data->>'show_in_expense_requests')::boolean,true),p_actor,p_actor) returning id into v_id;
    end if;
    select to_jsonb(t) into v_after from public.hr_expense_categories t where company_id=p_company and id=v_id;
  elsif p_kind='limit' then
    if not exists(select 1 from public.hr_expense_categories where company_id=p_company and id=(p_data->>'category_id')::uuid)
      or not exists(select 1 from public.designations where company_id=p_company and id=(p_data->>'designation_id')::uuid and is_active) then
      raise exception 'Select a head and active designation in this company.';
    end if;
    if p_data->>'excess_action'='special_approval' and not exists(select 1 from public.profiles where company_id=p_company and id=nullif(p_data->>'special_approver_user_id','')::uuid and is_active) then
      raise exception 'Choose an active special approver.';
    end if;
    if v_id is not null then
      select to_jsonb(t) into v_before from public.finance_reimbursement_limits t where company_id=p_company and id=v_id for update;
      if v_before is null then raise exception 'Limit not found.'; end if;
      if v_before->>'updated_at' is distinct from p_data->>'expected_updated_at' then raise exception 'Record changed. Refresh before saving.'; end if;
      update public.finance_reimbursement_limits set policy_note=nullif(trim(p_data->>'policy_note'),''),permissible_amount=(p_data->>'permissible_amount')::numeric,
        limit_basis=p_data->>'limit_basis',excess_action=p_data->>'excess_action',
        special_approver_user_id=case when p_data->>'excess_action'='special_approval' then (p_data->>'special_approver_user_id')::uuid end,
        is_active=(p_data->>'is_active')::boolean,updated_by=p_actor,updated_at=clock_timestamp()
      where company_id=p_company and id=v_id;
    else
      insert into public.finance_reimbursement_limits(company_id,category_id,designation_id,permissible_amount,limit_basis,excess_action,special_approver_user_id,effective_from,is_active,updated_by,policy_note)
      values(p_company,(p_data->>'category_id')::uuid,(p_data->>'designation_id')::uuid,(p_data->>'permissible_amount')::numeric,
        p_data->>'limit_basis',p_data->>'excess_action',case when p_data->>'excess_action'='special_approval' then (p_data->>'special_approver_user_id')::uuid end,
        (p_data->>'effective_from')::date,coalesce((p_data->>'is_active')::boolean,true),p_actor,nullif(trim(p_data->>'policy_note'),'')) returning id into v_id;
    end if;
    select to_jsonb(t) into v_after from public.finance_reimbursement_limits t where company_id=p_company and id=v_id;
  elsif p_kind='payment_mapping' then
    select to_jsonb(t) into v_before from public.hr_expense_policies t where company_id=p_company and id=v_id for update;
    if v_before is null then raise exception 'Reimbursement payment policy not found.'; end if;
    if v_before->>'updated_at' is distinct from p_data->>'expected_updated_at' then raise exception 'Record changed. Refresh before saving.'; end if;
    if not exists(select 1 from public.payment_heads where company_id=p_company and id=(p_data->>'payment_head_id')::uuid and is_active and cardinality(payment_process_role_ids)>0) then
      raise exception 'Choose an active payment head with Finance processors.';
    end if;
    update public.hr_expense_policies set payment_head_id=(p_data->>'payment_head_id')::uuid,updated_by=p_actor,updated_at=clock_timestamp()
      where company_id=p_company and id=v_id;
    select to_jsonb(t) into v_after from public.hr_expense_policies t where company_id=p_company and id=v_id;
  else raise exception 'Unknown master type.';
  end if;
  insert into public.finance_reimbursement_audit(company_id,record_type,record_id,before_value,after_value,actor_user_id)
    values(p_company,p_kind,v_id,v_before,v_after,p_actor);
  return v_id;
end $function$
;

-- Keep the existing service-only Finance mutation contract.
revoke all on function public.finance_save_reimbursement_master(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_save_reimbursement_master(uuid,uuid,text,jsonb) to service_role;

create or replace function public.finance_validate_expense_request_heads()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  expense record;
begin
  if tg_op = 'UPDATE' and new.expected_expenses is not distinct from old.expected_expenses then
    return new;
  end if;
  for expense in select key,value from jsonb_each(coalesce(new.expected_expenses,'{}'::jsonb))
  loop
    if jsonb_typeof(expense.value) <> 'number' then
      raise exception 'Expected expense amounts must be numbers.';
    end if;
    if expense.value::text::numeric > 0 and not exists (
      select 1 from public.hr_expense_categories c
      where c.company_id=new.company_id and c.id::text=expense.key
        and c.is_active and c.show_in_expense_requests
    ) then
      raise exception 'Expense categories have changed. Refresh the form and review your estimates.';
    end if;
  end loop;
  return new;
end;
$function$;

revoke all on function public.finance_validate_expense_request_heads() from public,anon,authenticated;
grant execute on function public.finance_validate_expense_request_heads() to service_role;

create trigger finance_expense_request_heads_guard
before insert or update of expected_expenses on public.hr_expense_claim_requests
for each row execute function public.finance_validate_expense_request_heads();

commit;
