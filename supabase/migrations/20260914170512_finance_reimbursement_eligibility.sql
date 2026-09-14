begin;
alter table public.finance_reimbursement_limits drop constraint finance_reimbursement_limits_limit_basis_check;
alter table public.finance_reimbursement_limits drop constraint finance_reimbursement_limits_permissible_amount_check;
alter table public.finance_reimbursement_limits add constraint finance_reimbursement_limits_limit_basis_check check(limit_basis in ('per_day','per_item','per_km','not_allowed'));
alter table public.finance_reimbursement_limits add constraint finance_reimbursement_limits_permissible_amount_check
 check((limit_basis='not_allowed' and permissible_amount=0 and excess_action='cap') or (limit_basis<>'not_allowed' and permissible_amount>0));
create or replace function public.finance_quote_reimbursement(p_company uuid,p_person uuid,p_items jsonb,p_claim uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item jsonb; v_category public.hr_expense_categories%rowtype; v_rule public.finance_reimbursement_limits%rowtype;
  v_designation uuid; v_day date; v_amount numeric; v_used numeric; v_remaining numeric; v_allowed numeric;
  v_result jsonb:='[]'; v_day_totals jsonb:='{}'; v_key text; v_basis text; v_limit numeric; v_action text; v_quantity numeric; v_requires_quantity boolean;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>50 then raise exception 'Invalid expense lines.'; end if;
  if not exists(select 1 from public.hr_engagements where company_id=p_company and person_id=p_person and status='active') then raise exception 'Active claimant not found.'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity:=nullif(v_item->>'quantity','')::numeric;
    if v_quantity is not null and (v_quantity<=0 or v_quantity>100000) then raise exception 'Enter valid distance in kilometres.'; end if;
    v_requires_quantity:=false;
    v_day := (v_item->>'expense_date')::date; v_amount:=(v_item->>'amount')::numeric;
    if v_day is null or v_amount is null or v_amount<=0 or v_amount>9999999999 then raise exception 'Enter a valid date and positive amount.'; end if;
    select * into v_category from public.hr_expense_categories where company_id=p_company and id=(v_item->>'category_id')::uuid and is_active;
    if not found then raise exception 'Expense head is inactive or unavailable.'; end if;
    select a.designation_id into v_designation from public.hr_work_assignments a join public.hr_engagements e on e.id=a.engagement_id and e.company_id=a.company_id
      where a.company_id=p_company and e.person_id=p_person and a.is_primary and a.effective_from<=v_day and (a.effective_to is null or a.effective_to>=v_day)
      order by a.effective_from desc,a.id limit 1;
    select * into v_rule from public.finance_reimbursement_limits where company_id=p_company and designation_id=v_designation
      and category_id=v_category.id and effective_from<=v_day order by effective_from desc,id limit 1;
    -- A disabled newest revision does not silently reactivate an older revision.
    if v_rule.id is not null and v_rule.is_active then
      v_limit:=v_rule.permissible_amount; v_basis:=v_rule.limit_basis; v_action:=v_rule.excess_action;
    else
      v_limit:=null; v_basis:=null; v_action:=null;
    end if;
    v_used:=0; v_allowed:=v_amount;
    if v_limit is not null then
      if v_basis='per_day' then
        v_key:=v_category.id::text||':'||v_day::text;
        select coalesce(sum(coalesce((i.finance_policy_snapshot->>'eligible_amount')::numeric,i.approved_amount,i.amount)),0) into v_used
          from public.hr_expense_items i join public.hr_expense_claims c on c.id=i.claim_id and c.company_id=i.company_id
          where c.company_id=p_company and c.claimant_person_id=p_person and c.id is distinct from p_claim
            and c.status not in ('rejected','withdrawn','returned') and i.category_id=v_category.id and i.expense_date=v_day;
        v_used:=v_used+coalesce((v_day_totals->>v_key)::numeric,0);
        v_remaining:=greatest(0,v_limit-v_used);
        v_day_totals:=jsonb_set(v_day_totals,array[v_key],to_jsonb(coalesce((v_day_totals->>v_key)::numeric,0)+v_amount));
      elsif v_basis='not_allowed' then v_remaining:=0;
      elsif v_basis='per_km' then
        v_requires_quantity:=v_quantity is null;
        v_remaining:=case when v_requires_quantity then v_amount else round(v_limit*v_quantity,2) end;
      else v_remaining:=v_limit; end if;
      v_allowed:=least(v_amount,v_remaining);
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_item->>'id','category_id',v_category.id,'head_name',v_category.name,
      'designation_id',v_designation,'expense_date',v_day,'quantity',v_quantity,'quantity_required',v_requires_quantity,'expense_allowed',coalesce(v_basis<>'not_allowed',true),'policy_note',v_rule.policy_note,'claimed_amount',v_amount,'limit_amount',v_limit,'limit_basis',v_basis,
      'already_used',v_used,'permissible_amount',case when v_limit is not null then v_allowed end,'excess_amount',v_amount-v_allowed,
      'eligible_amount',case when v_action='cap' then v_allowed else v_amount end,'excess_action',v_action,
      'special_approver_user_id',case when v_action='special_approval' and v_amount>v_allowed then v_rule.special_approver_user_id end,
      'rule_id',case when v_limit is not null then v_rule.id end,'rule_updated_at',case when v_limit is not null then v_rule.updated_at end));
  end loop;
  return v_result;
end $$;



create or replace function public.finance_apply_claim_policy() returns trigger language plpgsql security definer set search_path='' as $$
declare v_claim public.hr_expense_claims%rowtype; v_items jsonb; v_quote jsonb; v_line jsonb; v_approver uuid; v_order integer;
begin
  if new.event_type not in ('submitted','resubmitted') then return new; end if;
  select * into v_claim from public.hr_expense_claims where company_id=new.company_id and id=new.claim_id for update;
  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text||':'||v_claim.claimant_person_id::text,0));
  select jsonb_agg(jsonb_build_object('id',id,'category_id',category_id,'expense_date',expense_date,'amount',amount,'quantity',quantity) order by sort_order,id)
    into v_items from public.hr_expense_items where company_id=new.company_id and claim_id=new.claim_id;
  v_quote:=public.finance_quote_reimbursement(new.company_id,v_claim.claimant_person_id,v_items,new.claim_id);
  if exists(select 1 from jsonb_array_elements(v_quote) where value->>'expense_allowed'='false') then raise exception 'This expense head is not eligible for your designation under the Finance policy.'; end if;
  if exists(select 1 from jsonb_array_elements(v_quote) where (value->>'quantity_required')::boolean) then raise exception 'Enter distance in kilometres for mileage expenses.'; end if;
  if (select sum((value->>'eligible_amount')::numeric) from jsonb_array_elements(v_quote))<=0 then
    raise exception 'The daily policy allowance is already used. No payable amount remains for this claim.';
  end if;
  for v_line in select value from jsonb_array_elements(v_quote) loop
    update public.hr_expense_items set finance_policy_snapshot=v_line where company_id=new.company_id and id=(v_line->>'id')::uuid;
  end loop;
  for v_approver in select distinct (value->>'special_approver_user_id')::uuid from jsonb_array_elements(v_quote) where value->>'special_approver_user_id' is not null loop
    if not exists(select 1 from public.profiles where company_id=new.company_id and id=v_approver and is_active)
      or v_approver=v_claim.claimant_user_id or exists(select 1 from public.hr_user_person_links where company_id=new.company_id and user_id=v_approver and person_id=v_claim.claimant_person_id) then
      raise exception 'Finance must configure an active, independent special approver for this excess.';
    end if;
    select coalesce(max(step_order),0)+1 into v_order from public.hr_expense_approval_steps where company_id=new.company_id and claim_id=new.claim_id;
    insert into public.hr_expense_approval_steps(company_id,claim_id,step_order,step_name,approver_user_id,status,is_policy_exception)
      values(new.company_id,new.claim_id,v_order,'Policy excess · special approval',v_approver,case when v_order=1 then 'pending' else 'waiting' end,true);
  end loop;
  update public.hr_expense_claims set current_step=(select min(step_order) from public.hr_expense_approval_steps where company_id=new.company_id and claim_id=new.claim_id and status='pending')
    where company_id=new.company_id and id=new.claim_id;
  new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('finance_policy',v_quote);
  return new;
end $$;


commit;
