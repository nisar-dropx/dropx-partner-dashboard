begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Approved request amounts stay unchanged. NULL retains the legacy full-paid
-- interpretation for requests completed before instalment settlement existed.
alter table public.payment_requests add column if not exists bank_paid_amount numeric(14,2);
alter table public.hr_payroll_bank_lines add column if not exists instruction_amount numeric(14,2);

create table if not exists public.payment_request_bank_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  payment_request_id uuid not null references public.payment_requests(id),
  reference_no text not null,
  amount numeric(14,2) not null check(amount > 0),
  credit_account text not null,
  ifsc text not null,
  utr_cin text not null,
  normalized_utr text not null,
  response_row jsonb not null,
  actor_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(company_id,normalized_utr)
);
create index if not exists payment_request_bank_settlements_request_idx
  on public.payment_request_bank_settlements(company_id,payment_request_id);
create index if not exists payment_request_bank_settlements_request_id_idx
  on public.payment_request_bank_settlements(payment_request_id);
create index if not exists payment_request_bank_settlements_actor_idx
  on public.payment_request_bank_settlements(actor_user_id);
alter table public.payment_request_bank_settlements enable row level security;
revoke all on public.payment_request_bank_settlements from public,anon,authenticated,service_role;
grant select on public.payment_request_bank_settlements to service_role;

create or replace function public.guard_payment_request_bank_settlement()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Bank settlement evidence is immutable.';
end $$;
drop trigger if exists payment_request_bank_settlement_immutable on public.payment_request_bank_settlements;
create trigger payment_request_bank_settlement_immutable before update or delete
  on public.payment_request_bank_settlements for each row execute function public.guard_payment_request_bank_settlement();
revoke all on function public.guard_payment_request_bank_settlement() from public,anon,authenticated;

-- A request may now have several independently confirmed credits. Company/UTR
-- uniqueness is retained across every ledger; payroll still has one UTR/line.
alter table public.central_bank_paid_transaction_registry drop constraint if exists central_bank_paid_transaction_registry_entity_unique;
drop index if exists public.central_bank_paid_transaction_registry_entity_unique;
create unique index if not exists central_bank_paid_transaction_registry_nonrequest_entity_unique
  on public.central_bank_paid_transaction_registry(company_id,ledger,entity_id)
  where ledger <> 'payment_requests';
create index if not exists central_bank_paid_transaction_registry_request_entity_idx
  on public.central_bank_paid_transaction_registry(company_id,ledger,entity_id)
  where ledger = 'payment_requests';

create or replace function public.guard_payment_request_bank_balance()
returns trigger language plpgsql set search_path='' as $$
declare total numeric; recorded numeric;
begin
  if tg_op='INSERT' then
    if new.bank_paid_amount is not null then raise exception 'Paid balances may change only through bank settlement reconciliation.'; end if;
    return new;
  end if;
  total:=round(coalesce(new.amount,new.amount_requested,0),2);
  if new.bank_paid_amount is distinct from old.bank_paid_amount then
    if current_setting('app.payment_request_bank_settlement',true) is distinct from 'allowed' then
      raise exception 'Paid balances may change only through bank settlement reconciliation.';
    end if;
    select coalesce(sum(amount),0) into recorded from public.payment_request_bank_settlements
      where company_id=new.company_id and payment_request_id=new.id;
    if new.bank_paid_amount is null or new.bank_paid_amount<>recorded then
      raise exception 'Paid balance must equal immutable bank settlement evidence.';
    end if;
  end if;
  if new.bank_paid_amount is not null and (new.bank_paid_amount<0 or new.bank_paid_amount>total) then
    raise exception 'Bank-paid amount exceeds the approved payment balance.';
  end if;
  if coalesce(old.bank_paid_amount,0)>0 and (
    new.company_id is distinct from old.company_id or new.request_no is distinct from old.request_no
    or new.amount is distinct from old.amount or new.amount_requested is distinct from old.amount_requested
    or new.bank_account_no is distinct from old.bank_account_no
    or new.beneficiary_account_no is distinct from old.beneficiary_account_no
    or new.beneficiary_account_number is distinct from old.beneficiary_account_number
    or new.ifsc is distinct from old.ifsc or new.beneficiary_ifsc is distinct from old.beneficiary_ifsc
  ) then raise exception 'Partially paid request amount and beneficiary are frozen; retain its bank settlement history.'; end if;
  if coalesce(new.bank_paid_amount,0)>0 and new.bank_paid_amount<total
    and (lower(new.status)='processed' or upper(coalesce(new.approval_status,''))='PROCESSED') then
    raise exception 'This request is partially paid. Finalize the remaining bank credit before marking it fully processed.';
  end if;
  return new;
end $$;
drop trigger if exists payment_requests_bank_balance_guard on public.payment_requests;
create trigger payment_requests_bank_balance_guard before insert or update on public.payment_requests
  for each row execute function public.guard_payment_request_bank_balance();
revoke all on function public.guard_payment_request_bank_balance() from public,anon,authenticated;

create or replace function public.guard_payroll_bank_settled_amount()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.status='paid' and old.instruction_amount is not null and (
    new.amount is distinct from old.amount or new.instruction_amount is distinct from old.instruction_amount
    or new.credit_account is distinct from old.credit_account or new.ifsc is distinct from old.ifsc
    or new.reference is distinct from old.reference or new.company_id is distinct from old.company_id
  ) then raise exception 'Paid payroll credit and original instruction evidence are immutable.'; end if;
  if new.instruction_amount is not null and (new.amount<=0 or new.amount>new.instruction_amount) then
    raise exception 'Payroll bank credit must be positive and cannot exceed its original instruction.';
  end if;
  return new;
end $$;
drop trigger if exists payroll_bank_settled_amount_guard on public.hr_payroll_bank_lines;
create trigger payroll_bank_settled_amount_guard before update on public.hr_payroll_bank_lines
  for each row execute function public.guard_payroll_bank_settled_amount();
revoke all on function public.guard_payroll_bank_settled_amount() from public,anon,authenticated;

create or replace function public.finalize_payment_request_bank_credit(
  p_company uuid,p_actor uuid,p_row jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
<<settlement>>
declare
  r public.payment_requests%rowtype;
  prior public.payment_request_bank_settlements%rowtype;
  ref text:=public.workforce_payout_bank_reference_canonical(p_row->>'reference_no');
  account text:=public.workforce_payout_bank_account_canonical(p_row->>'credit_account');
  bank_ifsc text:=public.workforce_payout_bank_ifsc_canonical(p_row->>'ifsc');
  bank_status text:=upper(btrim(coalesce(p_row->>'status','')));
  utr text:=btrim(coalesce(p_row->>'utr_cin',''));
  normalized_utr text:=regexp_replace(upper(btrim(coalesce(p_row->>'utr_cin',''))),'[^A-Z0-9]','','g');
  remarks text:=nullif(btrim(coalesce(p_row->>'remarks','')),'');
  amount_text text:=btrim(coalesce(p_row->>'debit_amount_paise',''));
  paid numeric; total numeric; credit numeric; remaining numeric; seq integer;
  outcome text; message text; event jsonb; old_flag text;
begin
  if bank_status='CANCELED' then bank_status:='CANCELLED'; end if;
  select * into strict r from public.payment_requests
    where company_id=p_company and public.workforce_payout_bank_reference_canonical(request_no)=ref for update;
  if lower(coalesce(r.payment_mode,'account_transfer'))<>'account_transfer' then
    return jsonb_build_object('outcome','rejected','message','This payment request is not an account transfer.');
  end if;
  if account !~ '^[A-Z0-9]{4,30}$' or bank_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' or account<>public.workforce_payout_bank_account_canonical(
    coalesce(nullif(r.beneficiary_account_number,''),nullif(r.beneficiary_account_no,''),r.bank_account_no))
    or bank_ifsc<>public.workforce_payout_bank_ifsc_canonical(coalesce(nullif(r.beneficiary_ifsc,''),r.ifsc)) then
    return jsonb_build_object('outcome','rejected','message','Credit account or IFSC does not match the payment request.');
  end if;
  if amount_text !~ '^[1-9][0-9]*$' then
    return jsonb_build_object('outcome','rejected','message','Debit amount paise must be a positive integer.');
  end if;
  credit:=amount_text::numeric/100;
  total:=round(coalesce(r.amount,r.amount_requested,0),2);
  paid:=coalesce(r.bank_paid_amount,case when lower(r.status)='processed' or upper(coalesce(r.approval_status,''))='PROCESSED' then total else 0 end);
  if bank_status not in ('PAID','CANCELLED') then
    return jsonb_build_object('outcome','rejected','message','Status must be PAID or CANCELLED.');
  end if;
  if bank_status='PAID' and normalized_utr in ('','0','NA','NIL','NONE','NULL','NOTAVAILABLE','NOTAPPLICABLE') then
    return jsonb_build_object('outcome','rejected','message','A meaningful bank UTR/CIN is required for a paid payment request.');
  end if;
  if bank_status='PAID' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-bank-paid-utr:'||p_company::text||':'||normalized_utr,0));
    select * into prior from public.payment_request_bank_settlements s
      where s.company_id=p_company and s.normalized_utr=settlement.normalized_utr;
    if found then
      if prior.payment_request_id=r.id and prior.amount=credit and prior.credit_account=account and prior.ifsc=bank_ifsc then
        return jsonb_build_object('outcome','replayed','message','This bank credit was already recorded.');
      end if;
      return jsonb_build_object('outcome','rejected','message','This UTR/CIN is already recorded with different payment evidence.');
    end if;
  end if;
  if paid>=total then
    if bank_status='CANCELLED' then
      return jsonb_build_object('outcome','replayed','message','A paid payment request is never downgraded by a later cancellation.');
    elsif r.bank_paid_amount is null and credit=total
      and regexp_replace(upper(coalesce(r.utr_cin,'')),'[^A-Z0-9]','','g')=normalized_utr then
      return jsonb_build_object('outcome','replayed','message','This legacy paid payment request was already recorded.');
    end if;
    return jsonb_build_object('outcome','rejected','message','This payment request is already fully paid.');
  end if;
  if lower(r.status)='returned' and bank_status='CANCELLED' then
    return jsonb_build_object('outcome','replayed','message','This cancelled payment request was already returned.');
  end if;
  if not(lower(coalesce(r.status,'')) in ('approved','processing')
    or upper(coalesce(r.status,'')) like '%\_APPROVED' escape '\'
    or upper(coalesce(r.approval_status,'')) in ('APPROVED','FINAL_APPROVED','OWNER_APPROVED','RE_APPROVED','PROCESSING')) then
    return jsonb_build_object('outcome','rejected','message','This payment request is not approved for bank processing.');
  end if;
  if bank_status='PAID' and credit>total-paid then
    return jsonb_build_object('outcome','rejected','message','Bank credit exceeds the unpaid approved balance.');
  end if;
  -- Older app deployments still export full request amounts. They must not
  -- create a new partial balance before the balance-aware download is live.
  if bank_status='PAID' and credit<total-paid and coalesce(p_row->>'supports_partial_settlement','false')<>'true' then
    return jsonb_build_object('outcome','rejected','message','Refresh the payment processing application before recording a partial bank credit.');
  end if;
  select coalesce(max(sequence_no),0)+1 into seq from public.payment_request_approvals
    where company_id=p_company and (payment_request_id=r.id or request_id=r.id);
  if bank_status='PAID' then
    if exists(select 1 from public.payout_bank_paid_transaction_registry x where x.company_id=p_company and x.normalized_utr=settlement.normalized_utr)
      or exists(select 1 from public.central_bank_paid_transaction_registry x where x.company_id=p_company and x.normalized_utr=settlement.normalized_utr) then
      return jsonb_build_object('outcome','rejected','message','This UTR/CIN is already recorded for another paid instruction.');
    end if;
    insert into public.payment_request_bank_settlements(company_id,payment_request_id,reference_no,amount,credit_account,ifsc,utr_cin,normalized_utr,response_row,actor_user_id)
      values(p_company,r.id,ref,credit,account,bank_ifsc,utr,normalized_utr,p_row,p_actor);
    insert into public.central_bank_paid_transaction_registry(company_id,normalized_utr,ledger,entity_id,reference_no)
      values(p_company,normalized_utr,'payment_requests',r.id,ref);
    paid:=paid+credit; remaining:=total-paid;
    old_flag:=current_setting('app.payment_request_bank_settlement',true);
    perform set_config('app.payment_request_bank_settlement','allowed',true);
    update public.payment_requests set bank_paid_amount=paid,
      status=case when remaining=0 then 'processed' else 'processing' end,
      approval_status=case when remaining=0 then 'PROCESSED' else 'PROCESSING' end,
      bank_status=case when remaining=0 then 'Paid' else 'Partial Payment' end,
      utr_cin=settlement.utr,bank_processing_remarks=settlement.remarks,
      processing_started_at=coalesce(processing_started_at,clock_timestamp()),
      processed_at=case when remaining=0 then clock_timestamp() else null end,
      updated_at=clock_timestamp(),updated_by=p_actor where id=r.id and company_id=p_company;
    perform set_config('app.payment_request_bank_settlement',coalesce(old_flag,''),true);
    insert into public.payment_request_approvals(company_id,request_id,payment_request_id,sequence_no,role_code,status,action,comments,approver_user_id,approver_role_id,approval_cycle,created_at)
      values(p_company,r.id,r.id,seq,'BANK',case when remaining=0 then 'processed' else 'processing' end,
        case when remaining=0 then 'processed' else 'partial_payment' end,
        'Bank credit ₹'||credit||'; total paid ₹'||paid||'; remaining ₹'||remaining||'. UTR/CIN: '||utr,
        p_actor,r.current_approver_role_id,coalesce(r.approval_cycle,1),clock_timestamp());
    if remaining=0 then event:=jsonb_build_object('payment_request_id',r.id,'request_no',r.request_no,'status','paid','event_type','payment_processed','remarks',utr); end if;
    return jsonb_build_object('outcome','paid','message',case when remaining=0 then 'Payment request fully paid.' else 'Partial payment recorded; remaining balance is available for the next bank file.' end,
      'settled_amount',credit,'paid_amount',paid,'remaining_amount',remaining,'event',event);
  end if;
  -- A failed remaining instalment never erases earlier successful credits.
  update public.payment_requests set status=case when paid>0 then 'processing' else 'returned' end,
    approval_status=case when paid>0 then 'PROCESSING' else 'RETURNED' end,
    bank_status=case when paid>0 then 'Partial Payment' else 'Cancelled' end,
    bank_processing_remarks=settlement.remarks,current_approver_user_id=null,current_approver_role_id=null,
    updated_at=clock_timestamp(),updated_by=p_actor where company_id=p_company and id=r.id;
  insert into public.payment_request_approvals(company_id,request_id,payment_request_id,sequence_no,role_code,status,action,comments,approver_user_id,approver_role_id,approval_cycle,created_at)
    values(p_company,r.id,r.id,seq,'BANK',case when paid>0 then 'processing' else 'returned' end,'returned',
      'Bank attempt cancelled; earlier paid ₹'||paid||' retained. '||coalesce(remarks,''),p_actor,r.current_approver_role_id,coalesce(r.approval_cycle,1),clock_timestamp());
  if paid=0 then event:=jsonb_build_object('payment_request_id',r.id,'request_no',r.request_no,'status','returned','event_type','payment_returned','remarks','Payment Failed - '||coalesce(remarks,'Cancelled by bank')); end if;
  return jsonb_build_object('outcome','cancelled','message','Bank attempt cancelled; previously paid credits are retained.','event',event);
end $$;
revoke all on function public.finalize_payment_request_bank_credit(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- PATCH_BANK_FINALIZERS
do $patch$
declare body text; changed text; name text; amount_expr text;
begin
  foreach name in array array['workforce_finalize_payout_payment_response','helper_finalize_payout_payment_response'] loop
    select pg_get_functiondef(p.oid) into body from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proname=name;
    if body is null then continue; end if;
    amount_expr:=case when name='helper_finalize_payout_payment_response' then 'v_amount_paise_text::numeric' else 'v_amount_paise' end;
    changed:=replace(body,'or '||amount_expr||' <> round(v_item.instruction_amount * 100, 0)',
      'or (v_status = ''PAID'' and ('||amount_expr||' > round(v_item.instruction_amount * 100, 0) or ('||amount_expr||' < round(v_item.instruction_amount*100,0) and coalesce(v_row->>''supports_partial_settlement'',''false'')<>''true'')))');
    changed:=replace(changed,'Account, IFSC or exact debit amount does not match the generated instruction.',
      'Credit account or IFSC does not match, or bank credit exceeds the generated instruction.');
    changed:=replace(changed,'Account, IFSC or exact debit amount does not match the instruction.',
      'Credit account or IFSC does not match, or bank credit exceeds the instruction.');
    changed:=replace(changed,'if v_item.bank_response_status = v_status',
      'if (v_status <> ''PAID'' or '||amount_expr||' = round(coalesce(v_item.settled_amount,v_item.instruction_amount)*100,0)) and v_item.bank_response_status = v_status');
    if position('v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)' in changed)=0 then
      changed:=replace(changed,'or (v_status = ''PAID'' and ('||amount_expr||' > round(v_item.instruction_amount * 100, 0)',
        'or v_account <> public.workforce_payout_bank_account_canonical(v_item.bank_account_no_snapshot)'||chr(10)||
        '      or v_ifsc <> public.workforce_payout_bank_ifsc_canonical(v_item.ifsc_snapshot)'||chr(10)||
        '      or (v_status = ''PAID'' and ('||amount_expr||' > round(v_item.instruction_amount * 100, 0)');
    end if;
    if changed=body and position(amount_expr||' > round(v_item.instruction_amount' in body)=0 then
      raise exception 'Unexpected payout finalizer definition: %',name;
    end if;
    execute changed;
  end loop;
  select pg_get_functiondef(p.oid) into body from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='finalize_central_bank_response';
  changed:=regexp_replace(body,
    '  for v_row_record in\s+select response.value, response.ordinality::integer as position\s+from jsonb_array_elements\(p_payment_request_rows\)[\s\S]*?(?=  for v_row_record in\s+select response.value, response.ordinality::integer as position\s+from jsonb_array_elements\(p_payroll_rows\))',
    $replacement$  for v_row_record in select response.value,response.ordinality::integer as position
    from jsonb_array_elements(p_payment_request_rows) with ordinality response(value,ordinality)
  loop
    v_row:=v_row_record.value;
    v_generic_result:=public.finalize_payment_request_bank_credit(p_company_id,p_actor_user_id,v_row);
    v_status:=v_generic_result->>'outcome';
    v_generic_paid:=v_generic_paid+case when v_status='paid' then 1 else 0 end;
    v_generic_cancelled:=v_generic_cancelled+case when v_status='cancelled' then 1 else 0 end;
    v_generic_replayed:=v_generic_replayed+case when v_status='replayed' then 1 else 0 end;
    v_generic_rejected:=v_generic_rejected+case when v_status='rejected' then 1 else 0 end;
    v_generic_rows:=v_generic_rows||jsonb_build_array((v_generic_result-'event')||jsonb_build_object(
      'ledger','payment_requests','row_number',coalesce((v_row->>'row_number')::integer,v_row_record.position),
      'reference_no',public.workforce_payout_bank_reference_canonical(v_row->>'reference_no')));
    if jsonb_typeof(v_generic_result->'event')='object' then
      v_payment_events:=v_payment_events||jsonb_build_array(v_generic_result->'event');
    end if;
  end loop;

$replacement$);
  if changed=body and position('finalize_payment_request_bank_credit(' in body)=0 then raise exception 'Unexpected central request finalizer definition'; end if;
  body:=changed;
  body:=regexp_replace(body,
    'if v_ledger in \(''workforce'', ''helpers''\)[\s\S]*?raise exception ''Value date does not match the generated instruction for reference %.'', v_reference;\s+end if;',
    '-- Bank value date is retained as evidence, not used to match the instruction.');
  changed:=replace(body,'round(v_payroll_line.amount * 100, 0)','round(coalesce(v_payroll_line.instruction_amount,v_payroll_line.amount) * 100, 0)');
  changed:=regexp_replace(changed,'or v_amount_paise <> v_expected_amount_paise[\s\S]*?\s+then',
    'or (v_status = ''PAID'' and (v_amount_paise > v_expected_amount_paise or (v_amount_paise < v_expected_amount_paise and coalesce(v_row->>''supports_partial_settlement'',''false'')<>''true'')))'||chr(10)||'    then');
  changed:=replace(changed,'Account, IFSC, value date or exact debit amount does not match the payroll instruction.',
    'Credit account or IFSC does not match, or bank credit exceeds the payroll instruction.');
  if position('instruction_amount=coalesce(line.instruction_amount,line.amount)' in changed)=0 then
    changed:=replace(changed,'set status = ''paid'', utr = v_utr,',
      'set status = ''paid'', utr = v_utr, instruction_amount=coalesce(line.instruction_amount,line.amount), amount=round(v_amount_paise/100,2),');
  end if;
  changed:=replace(changed,'elsif regexp_replace(upper(btrim(v_payroll_line.utr)), ''[^A-Z0-9]'', '''', ''g'') = v_utr_normalized then',
    'elsif v_amount_paise=round(v_payroll_line.amount*100,0) and regexp_replace(upper(btrim(v_payroll_line.utr)), ''[^A-Z0-9]'', '''', ''g'') = v_utr_normalized then');
  execute changed;
  select pg_get_functiondef(p.oid) into body from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='finalize_central_bank_response_partially';
  changed:=replace(body,'when ''payment_requests'' then ('||chr(10),
    'when ''payment_requests'' then not exists (select 1 from public.payment_request_bank_settlements paid_credit where paid_credit.company_id=p_company_id and paid_credit.reference_no=evidence.reference_no and paid_credit.normalized_utr=evidence.normalized_utr) and ('||chr(10));
  changed:=regexp_replace(changed,
    'when evidence.ledger = ''(workforce|helpers)''\s+and evidence.value_date_text[^;]*?then ''Value date does not match the generated bank instruction.''',
    '', 'g');
  execute changed;
end $patch$;

commit;
