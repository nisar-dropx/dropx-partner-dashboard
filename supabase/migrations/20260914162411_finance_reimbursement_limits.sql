-- Finance owns expense heads and designation limits. Existing claims are not repriced.
begin;

create table public.finance_reimbursement_limits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  category_id uuid not null references public.hr_expense_categories(id),
  designation_id uuid not null references public.designations(id),
  permissible_amount numeric(12,2) not null check (permissible_amount > 0),
  limit_basis text not null check (limit_basis in ('per_item','per_day')),
  excess_action text not null check (excess_action in ('cap','special_approval')),
  special_approver_user_id uuid references public.profiles(id),
  effective_from date not null,
  is_active boolean not null default true,
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  check (excess_action <> 'special_approval' or special_approver_user_id is not null),
  unique(company_id,designation_id,category_id,effective_from)
);
create index finance_reimbursement_limit_category on public.finance_reimbursement_limits(category_id);
create index finance_reimbursement_limit_designation on public.finance_reimbursement_limits(designation_id);
create index finance_reimbursement_limit_approver on public.finance_reimbursement_limits(special_approver_user_id);
create index finance_reimbursement_limit_editor on public.finance_reimbursement_limits(updated_by);
create table public.finance_reimbursement_audit (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  record_type text not null, record_id uuid not null, before_value jsonb, after_value jsonb,
  actor_user_id uuid not null references public.profiles(id), changed_at timestamptz not null default now()
);
create index finance_reimbursement_audit_record on public.finance_reimbursement_audit(company_id,record_id,changed_at desc);
create index finance_reimbursement_audit_actor on public.finance_reimbursement_audit(actor_user_id);
alter table public.finance_reimbursement_limits enable row level security;
alter table public.finance_reimbursement_audit enable row level security;
revoke all on public.finance_reimbursement_limits,public.finance_reimbursement_audit from public,anon,authenticated;
grant select,insert,update on public.finance_reimbursement_limits to service_role;
grant select,insert on public.finance_reimbursement_audit to service_role;

alter table public.hr_expense_items add column finance_policy_snapshot jsonb;
alter table public.hr_expense_approval_steps add column is_policy_exception boolean not null default false;

-- Authenticated Finance server actions check the Finance product and master permission.
-- This RPC is service-only; no browser can impersonate p_actor.
create function public.finance_save_reimbursement_master(p_company uuid,p_actor uuid,p_kind text,p_data jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid := nullif(p_data->>'id','')::uuid; v_before jsonb; v_after jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_actor and company_id=p_company and is_active) then
    raise exception 'Active Finance editor is required.';
  end if;
  if p_kind='head' then
    if length(trim(p_data->>'name')) < 2 or coalesce(p_data->>'code','') !~ '^[A-Z][A-Z0-9_]{1,39}$' then
      raise exception 'Enter a valid head code and name.';
    end if;
    if v_id is not null then
      select to_jsonb(t) into v_before from public.hr_expense_categories t where company_id=p_company and id=v_id for update;
      if v_before is null then raise exception 'Expense head not found.'; end if;
      if v_before->>'updated_at' is distinct from p_data->>'expected_updated_at' then raise exception 'Record changed. Refresh before saving.'; end if;
      update public.hr_expense_categories set name=trim(p_data->>'name'),description=nullif(trim(p_data->>'description'),''),
        receipt_required=(p_data->>'receipt_required')::boolean,receipt_threshold=(p_data->>'receipt_threshold')::numeric,
        is_active=(p_data->>'is_active')::boolean,updated_by=p_actor,updated_at=clock_timestamp()
        where company_id=p_company and id=v_id;
    else
      insert into public.hr_expense_categories(company_id,code,name,description,receipt_required,receipt_threshold,is_active,created_by,updated_by)
      values(p_company,p_data->>'code',trim(p_data->>'name'),nullif(trim(p_data->>'description'),''),
        (p_data->>'receipt_required')::boolean,(p_data->>'receipt_threshold')::numeric,coalesce((p_data->>'is_active')::boolean,true),p_actor,p_actor) returning id into v_id;
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
      update public.finance_reimbursement_limits set permissible_amount=(p_data->>'permissible_amount')::numeric,
        limit_basis=p_data->>'limit_basis',excess_action=p_data->>'excess_action',
        special_approver_user_id=case when p_data->>'excess_action'='special_approval' then (p_data->>'special_approver_user_id')::uuid end,
        is_active=(p_data->>'is_active')::boolean,updated_by=p_actor,updated_at=clock_timestamp()
      where company_id=p_company and id=v_id;
    else
      insert into public.finance_reimbursement_limits(company_id,category_id,designation_id,permissible_amount,limit_basis,excess_action,special_approver_user_id,effective_from,is_active,updated_by)
      values(p_company,(p_data->>'category_id')::uuid,(p_data->>'designation_id')::uuid,(p_data->>'permissible_amount')::numeric,
        p_data->>'limit_basis',p_data->>'excess_action',case when p_data->>'excess_action'='special_approval' then (p_data->>'special_approver_user_id')::uuid end,
        (p_data->>'effective_from')::date,coalesce((p_data->>'is_active')::boolean,true),p_actor) returning id into v_id;
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
end $$;

-- One expense-date per day/night; daily caps aggregate all live claims, not just one form.
create function public.finance_quote_reimbursement(p_company uuid,p_person uuid,p_items jsonb,p_claim uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item jsonb; v_category public.hr_expense_categories%rowtype; v_rule public.finance_reimbursement_limits%rowtype;
  v_designation uuid; v_day date; v_amount numeric; v_used numeric; v_remaining numeric; v_allowed numeric;
  v_result jsonb:='[]'; v_day_totals jsonb:='{}'; v_key text; v_basis text; v_limit numeric; v_action text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>50 then raise exception 'Invalid expense lines.'; end if;
  if not exists(select 1 from public.hr_engagements where company_id=p_company and person_id=p_person and status='active') then raise exception 'Active claimant not found.'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
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
      else v_remaining:=v_limit; end if;
      v_allowed:=least(v_amount,v_remaining);
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_item->>'id','category_id',v_category.id,'head_name',v_category.name,
      'designation_id',v_designation,'expense_date',v_day,'claimed_amount',v_amount,'limit_amount',v_limit,'limit_basis',v_basis,
      'already_used',v_used,'permissible_amount',case when v_limit is not null then v_allowed end,'excess_amount',v_amount-v_allowed,
      'eligible_amount',case when v_action='cap' then v_allowed else v_amount end,'excess_action',v_action,
      'special_approver_user_id',case when v_action='special_approval' and v_amount>v_allowed then v_rule.special_approver_user_id end,
      'rule_id',case when v_limit is not null then v_rule.id end,'rule_updated_at',case when v_limit is not null then v_rule.updated_at end));
  end loop;
  return v_result;
end $$;

-- Fired after the existing submission RPC has inserted every item and approval step.
-- The entire submission rolls back if policy evaluation or exception routing fails.
create function public.finance_apply_claim_policy() returns trigger language plpgsql security definer set search_path='' as $$
declare v_claim public.hr_expense_claims%rowtype; v_items jsonb; v_quote jsonb; v_line jsonb; v_approver uuid; v_order integer;
begin
  if new.event_type not in ('submitted','resubmitted') then return new; end if;
  select * into v_claim from public.hr_expense_claims where company_id=new.company_id and id=new.claim_id for update;
  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text||':'||v_claim.claimant_person_id::text,0));
  select jsonb_agg(jsonb_build_object('id',id,'category_id',category_id,'expense_date',expense_date,'amount',amount) order by sort_order,id)
    into v_items from public.hr_expense_items where company_id=new.company_id and claim_id=new.claim_id;
  v_quote:=public.finance_quote_reimbursement(new.company_id,v_claim.claimant_person_id,v_items,new.claim_id);
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
create trigger finance_apply_claim_policy before insert on public.hr_expense_events for each row execute function public.finance_apply_claim_policy();

create function public.finance_protect_exception_step() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.is_policy_exception and new.status='skipped' then return old; end if;
  if old.is_policy_exception and new.status='approved' and old.status<>'approved' and length(trim(coalesce(new.decision_note,'')))<3 then
    raise exception 'Add a short reason for approving the policy excess.';
  end if;
  return new;
end $$;
create trigger finance_protect_exception_step before update on public.hr_expense_approval_steps for each row execute function public.finance_protect_exception_step();

create function public.finance_guard_reimbursement_payment() returns trigger language plpgsql security definer set search_path='' as $$
declare v_claim public.hr_expense_claims%rowtype; v_payable numeric; v_count integer;
begin
  if new.source_type is distinct from 'employee_reimbursement' then return new; end if;
  select * into v_claim from public.hr_expense_claims where company_id=new.company_id and id=new.source_id for update;
  if not found then raise exception 'Reimbursement source not found.'; end if;
  select count(*),sum((finance_policy_snapshot->>'eligible_amount')::numeric) into v_count,v_payable
    from public.hr_expense_items where company_id=new.company_id and claim_id=v_claim.id and finance_policy_snapshot is not null;
  if v_count=0 then return new; end if; -- preserve pre-rollout approved claims
  if exists(select 1 from public.hr_expense_items where company_id=new.company_id and claim_id=v_claim.id and finance_policy_snapshot is null) then raise exception 'Incomplete Finance policy evaluation.'; end if;
  if exists(select 1 from public.hr_expense_items i where i.company_id=new.company_id and i.claim_id=v_claim.id
    and i.finance_policy_snapshot->>'special_approver_user_id' is not null and not exists(
      select 1 from public.hr_expense_approval_steps s where s.company_id=new.company_id and s.claim_id=v_claim.id and s.is_policy_exception
        and s.approver_user_id=(i.finance_policy_snapshot->>'special_approver_user_id')::uuid and s.status='approved')) then
    raise exception 'Policy excess requires special approval before payment.';
  end if;
  if v_payable<=0 then raise exception 'No payable amount remains within the policy limit.'; end if;
  if tg_op='INSERT' then
    new.amount:=v_payable; new.amount_requested:=v_claim.total_claimed;
    new.details:=coalesce(new.details,'{}')||jsonb_build_object('claimed_amount',v_claim.total_claimed,'policy_payable',v_payable,'policy_deduction',v_claim.total_claimed-v_payable);
  elsif new.amount is null or new.amount<=0 or new.amount>v_payable then raise exception 'Payment must be positive and cannot exceed the policy-approved amount.';
  end if;
  return new;
end $$;
create trigger finance_guard_reimbursement_payment before insert or update of amount on public.payment_requests for each row execute function public.finance_guard_reimbursement_payment();
create function public.finance_set_claim_approved_total() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='approved_for_payment' and new.payment_request_id is not null then
    select amount into new.total_approved from public.payment_requests where company_id=new.company_id and id=new.payment_request_id;
  end if;
  return new;
end $$;
create trigger finance_set_claim_approved_total before update of status,total_approved on public.hr_expense_claims for each row execute function public.finance_set_claim_approved_total();

-- All reimbursement mutation RPCs are called by authenticated server routes using service_role.
-- Their actor arguments must never be callable directly from an anonymous browser.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'finance_%reimbursement%' or p.proname in (
      'finance_apply_claim_policy','finance_protect_exception_step','finance_set_claim_approved_total',
      'hr_submit_expense_claim','hr_resubmit_expense_claim','hr_decide_expense_claim','hr_expense_claim_send_to_payment',
      'hr_submit_expense_claim_request','hr_decide_expense_claim_request','hr_withdraw_expense_claim','hr_withdraw_expense_claim_request')) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
