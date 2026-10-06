-- Reimbursement claims: multi-night daily limits, Finance payable adjustment,
-- and supporting approval documents.
--
-- 1. A per-day limit applied to one line covered one day only, so a single hotel
--    line for three nights was capped at one night's ceiling. A per-day line now
--    carries the number of days/nights it covers (hr_expense_items.quantity).
-- 2. The Finance approver of the current step may set the payable amount of a
--    line, up to the claimed bill, with a recorded reason.
-- 3. A claimant can attach the approval obtained for a policy excess as its own
--    document, separate from the receipt pack.
-- 4. A special approver routed before Finance no longer receives a second,
--    duplicate approval step after Finance.

begin;

-- hr_expense_events predates these migrations. Fail here, not at runtime, if it
-- restricts event types.
do $$
declare v_definition text;
begin
  for v_definition in
    select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.hr_expense_events'::regclass and c.contype = 'c'
  loop
    if v_definition ilike '%event_type%' and v_definition not ilike '%finance_amount_adjusted%' then
      raise exception 'hr_expense_events restricts event_type (%). Allow finance_amount_adjusted before applying this migration.', v_definition;
    end if;
  end loop;
end $$;

alter table public.hr_expense_attachments
  add column if not exists document_kind text not null default 'receipt';
alter table public.hr_expense_attachments
  drop constraint if exists hr_expense_attachments_document_kind_check;
alter table public.hr_expense_attachments
  add constraint hr_expense_attachments_document_kind_check
  check (document_kind in ('receipt', 'supporting_approval'));

comment on column public.hr_expense_attachments.document_kind is
  'receipt = merged bill pack; supporting_approval = approval obtained for a policy excess.';
comment on column public.hr_expense_items.quantity is
  'Kilometres for a per-km limit; days/nights covered by the line for a per-day limit.';

-- Daily caps aggregate all live claims. A per-day line covering N days/nights
-- draws on the allowance of each day from its expense date.
create or replace function public.finance_quote_reimbursement(p_company uuid,p_person uuid,p_items jsonb,p_claim uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item jsonb; v_category public.hr_expense_categories%rowtype; v_rule public.finance_reimbursement_limits%rowtype;
  v_designation uuid; v_day date; v_amount numeric; v_used numeric; v_remaining numeric; v_allowed numeric;
  v_result jsonb:='[]'; v_day_totals jsonb:='{}'; v_key text; v_basis text; v_limit numeric; v_action text; v_quantity numeric; v_requires_quantity boolean;
  v_units integer; v_offset integer; v_span_day date; v_day_used numeric;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>50 then raise exception 'Invalid expense lines.'; end if;
  if not exists(select 1 from public.hr_engagements where company_id=p_company and person_id=p_person and status='active') then raise exception 'Active claimant not found.'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity:=nullif(v_item->>'quantity','')::numeric;
    v_requires_quantity:=false; v_units:=null;
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
    if v_basis='per_day' then
      if v_quantity is not null and (v_quantity<1 or v_quantity>31 or v_quantity<>trunc(v_quantity)) then
        raise exception 'Enter the days or nights covered as a whole number from 1 to 31.';
      end if;
    elsif v_quantity is not null and (v_quantity<=0 or v_quantity>100000) then
      raise exception 'Enter valid distance in kilometres.';
    end if;
    v_used:=0; v_allowed:=v_amount;
    if v_limit is not null then
      if v_basis='per_day' then
        v_units:=coalesce(v_quantity,1)::integer; v_remaining:=0;
        for v_offset in 0..v_units-1 loop
          v_span_day:=v_day+v_offset;
          v_key:=v_category.id::text||':'||v_span_day::text;
          select coalesce(sum(coalesce((i.finance_policy_snapshot->>'eligible_amount')::numeric,i.approved_amount,i.amount)
              / greatest(1,case when i.finance_policy_snapshot->>'limit_basis'='per_day' then coalesce(i.quantity,1) else 1 end)),0) into v_day_used
            from public.hr_expense_items i join public.hr_expense_claims c on c.id=i.claim_id and c.company_id=i.company_id
            where c.company_id=p_company and c.claimant_person_id=p_person and c.id is distinct from p_claim
              and c.status not in ('rejected','withdrawn','returned') and i.category_id=v_category.id
              and v_span_day>=i.expense_date
              and v_span_day<i.expense_date+greatest(1,case when i.finance_policy_snapshot->>'limit_basis'='per_day' then coalesce(i.quantity,1) else 1 end)::integer;
          v_day_used:=v_day_used+coalesce((v_day_totals->>v_key)::numeric,0);
          v_used:=v_used+v_day_used;
          v_remaining:=v_remaining+greatest(0,v_limit-v_day_used);
          v_day_totals:=jsonb_set(v_day_totals,array[v_key],to_jsonb(coalesce((v_day_totals->>v_key)::numeric,0)+v_amount/v_units));
        end loop;
      elsif v_basis='not_allowed' then v_remaining:=0;
      elsif v_basis='per_km' then
        v_requires_quantity:=v_quantity is null;
        v_remaining:=case when v_requires_quantity then v_amount else round(v_limit*v_quantity,2) end;
      else v_remaining:=v_limit; end if;
      v_allowed:=least(v_amount,round(v_remaining,2));
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_item->>'id','category_id',v_category.id,'head_name',v_category.name,
      'designation_id',v_designation,'expense_date',v_day,'quantity',v_quantity,'days',v_units,'quantity_required',v_requires_quantity,'expense_allowed',coalesce(v_basis<>'not_allowed',true),'policy_note',v_rule.policy_note,'claimed_amount',v_amount,'limit_amount',v_limit,'limit_basis',v_basis,
      'already_used',v_used,'permissible_amount',case when v_limit is not null then v_allowed end,'excess_amount',v_amount-v_allowed,
      'eligible_amount',case when v_action='cap' then v_allowed else v_amount end,'excess_action',v_action,
      'special_approver_user_id',case when v_action='special_approval' and v_amount>v_allowed then v_rule.special_approver_user_id end,
      'rule_id',case when v_limit is not null then v_rule.id end,'rule_updated_at',case when v_limit is not null then v_rule.updated_at end));
  end loop;
  return v_result;
end $$;

-- The One submission route already places the special approver before Finance.
-- Reuse that step for the payment guard instead of appending a second approval
-- for the same person after Finance.
create or replace function public.finance_apply_claim_policy() returns trigger language plpgsql security definer set search_path='' as $$
declare v_claim public.hr_expense_claims%rowtype; v_items jsonb; v_quote jsonb; v_line jsonb; v_approver uuid; v_order integer; v_existing uuid;
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
    update public.hr_expense_items set finance_policy_snapshot=v_line,
      approved_amount=least(amount,greatest(0,(v_line->>'eligible_amount')::numeric))
    where company_id=new.company_id and id=(v_line->>'id')::uuid;
  end loop;
  for v_approver in select distinct (value->>'special_approver_user_id')::uuid from jsonb_array_elements(v_quote) where value->>'special_approver_user_id' is not null loop
    if not exists(select 1 from public.profiles where company_id=new.company_id and id=v_approver and is_active)
      or v_approver=v_claim.claimant_user_id or exists(select 1 from public.hr_user_person_links where company_id=new.company_id and user_id=v_approver and person_id=v_claim.claimant_person_id) then
      raise exception 'Finance must configure an active, independent special approver for this excess.';
    end if;
    select s.id into v_existing from public.hr_expense_approval_steps s
      where s.company_id=new.company_id and s.claim_id=new.claim_id and s.approver_user_id=v_approver
      order by (s.stage_code='policy_exception') desc nulls last,s.step_order limit 1;
    if v_existing is not null then
      update public.hr_expense_approval_steps set is_policy_exception=true where id=v_existing;
    else
      select coalesce(max(step_order),0)+1 into v_order from public.hr_expense_approval_steps where company_id=new.company_id and claim_id=new.claim_id;
      insert into public.hr_expense_approval_steps(company_id,claim_id,step_order,step_name,approver_user_id,status,is_policy_exception)
        values(new.company_id,new.claim_id,v_order,'Policy excess · special approval',v_approver,case when v_order=1 then 'pending' else 'waiting' end,true);
    end if;
  end loop;
  update public.hr_expense_claims set current_step=(select min(step_order) from public.hr_expense_approval_steps where company_id=new.company_id and claim_id=new.claim_id and status='pending')
    where company_id=new.company_id and id=new.claim_id;
  new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('finance_policy',v_quote);
  return new;
end $$;

-- Finance may correct the payable amount of a line while the claim sits at the
-- Finance step: never above the claimed bill, always with a reason. The policy
-- assessment is kept beside the adjustment for audit.
create or replace function public.hr_finance_adjust_expense_item(
  p_company_id uuid,
  p_claim_id uuid,
  p_item_id uuid,
  p_actor_user_id uuid,
  p_amount numeric,
  p_note text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_step public.hr_expense_approval_steps%rowtype;
  v_item public.hr_expense_items%rowtype;
  v_amount numeric(12,2);
  v_note text := trim(coalesce(p_note, ''));
  v_previous numeric;
  v_policy numeric;
  v_actor_name text;
  v_actor_role text;
  v_actor_person_id uuid;
  v_total numeric;
begin
  if length(v_note) < 3 then raise exception 'Record why the payable amount is being changed.'; end if;
  if length(v_note) > 500 then raise exception 'Keep the reason within 500 characters.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter a valid payable amount.'; end if;
  v_amount := round(p_amount, 2);

  select claim.* into v_claim from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id for update;
  if not found or v_claim.status <> 'pending_approval' then raise exception 'This claim is no longer awaiting approval.'; end if;
  select step.* into v_step from public.hr_expense_approval_steps step
  where step.company_id = p_company_id and step.claim_id = p_claim_id and step.status = 'pending'
  order by step.step_order limit 1 for update;
  if not found or v_step.approver_user_id <> p_actor_user_id then raise exception 'This approval step is assigned to another user.'; end if;
  if v_step.stage_code is distinct from 'finance' then
    raise exception 'Only the Finance approver can change the payable amount.';
  end if;
  select link.person_id into v_actor_person_id from public.hr_user_person_links link
  where link.company_id = p_company_id and link.user_id = p_actor_user_id and link.status = 'active';
  if v_actor_person_id is not null and v_actor_person_id = v_claim.claimant_person_id then
    raise exception 'Self-approval is not allowed.';
  end if;

  select item.* into v_item from public.hr_expense_items item
  where item.company_id = p_company_id and item.claim_id = p_claim_id and item.id = p_item_id for update;
  if not found then raise exception 'This expense line was not found on the claim.'; end if;
  if v_amount > v_item.amount then
    raise exception 'The payable amount cannot exceed the claimed bill amount of Rs %.', v_item.amount;
  end if;

  v_previous := coalesce(v_item.approved_amount, nullif(v_item.finance_policy_snapshot->>'eligible_amount', '')::numeric, v_item.amount);
  v_policy := coalesce(
    nullif(v_item.finance_policy_snapshot #>> '{finance_adjustment,policy_eligible_amount}', '')::numeric,
    nullif(v_item.finance_policy_snapshot->>'eligible_amount', '')::numeric,
    v_item.amount
  );
  select profile.full_name, coalesce(profile.role::text, 'Finance') into v_actor_name, v_actor_role
  from public.profiles profile where profile.id = p_actor_user_id;

  -- Lines assessed before the policy rollout carry no snapshot; the payment
  -- guard reads approved_amount for those.
  update public.hr_expense_items item
  set approved_amount = v_amount,
      reviewer_note = v_note,
      finance_policy_snapshot = case when item.finance_policy_snapshot is null then null else
        item.finance_policy_snapshot || jsonb_build_object(
          'eligible_amount', v_amount,
          'finance_adjustment', jsonb_build_object(
            'policy_eligible_amount', v_policy,
            'amount', v_amount,
            'note', v_note,
            'adjusted_by', p_actor_user_id,
            'adjusted_by_name', coalesce(v_actor_name, 'Finance'),
            'adjusted_at', now()
          )
        ) end
  where item.id = v_item.id;

  select coalesce(sum(coalesce(item.approved_amount,
    nullif(item.finance_policy_snapshot->>'eligible_amount', '')::numeric, item.amount)), 0)
  into v_total
  from public.hr_expense_items item
  where item.company_id = p_company_id and item.claim_id = p_claim_id;

  insert into public.hr_expense_events(company_id, claim_id, event_type, from_status, to_status, actor_user_id, actor_name, actor_role, comments, metadata)
  values (
    p_company_id, p_claim_id, 'finance_amount_adjusted', 'pending_approval', 'pending_approval',
    p_actor_user_id, coalesce(v_actor_name, 'Finance'), coalesce(v_actor_role, 'Finance'), v_note,
    jsonb_build_object('item_id', v_item.id, 'claimed_amount', v_item.amount, 'policy_eligible_amount', v_policy,
      'previous_payable', v_previous, 'payable', v_amount, 'above_policy', v_amount > v_policy, 'claim_payable_total', v_total)
  );
  return jsonb_build_object('item_id', v_item.id, 'payable', v_amount, 'previous_payable', v_previous, 'claim_payable_total', v_total);
end $$;

revoke all on function public.hr_finance_adjust_expense_item(uuid, uuid, uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.hr_finance_adjust_expense_item(uuid, uuid, uuid, uuid, numeric, text) to service_role;

commit;
