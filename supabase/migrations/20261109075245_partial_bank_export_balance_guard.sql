begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

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
  if coalesce(old.bank_paid_amount,0)>0
    and old.bank_paid_amount<round(coalesce(old.amount,old.amount_requested,0),2)
    and new.bank_paid_amount is not distinct from old.bank_paid_amount
    and lower(new.status)='processing'
    and current_setting('app.payment_request_bank_settlement',true) is distinct from 'allowed' then
    raise exception 'Refresh the application: partial payments require a balance-aware bank export.';
  end if;
  return new;
end $$;

create or replace function public.prepare_payment_request_bank_export(
  p_company_id uuid,p_actor_user_id uuid,p_rows jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  entry jsonb; r public.payment_requests%rowtype; total numeric; paid numeric;
  old_flag text:=current_setting('app.payment_request_bank_settlement',true);
  prepared integer:=0; seq integer;
begin
  if p_company_id is null or p_actor_user_id is null or not exists(select 1 from public.profiles where id=p_actor_user_id and is_active) then
    raise exception 'Company and valid payment actor are required.';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'Select between 1 and 5000 payment requests for bank export.';
  end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) then
    raise exception 'Bank export contains duplicate or missing payment request IDs.';
  end if;
  perform set_config('app.payment_request_bank_settlement','allowed',true);
  for entry in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select * into r from public.payment_requests
      where company_id=p_company_id and id=(entry->>'id')::uuid for update;
    if not found then raise exception 'A selected payment no longer belongs to this company.'; end if;
    if lower(coalesce(r.payment_mode,'account_transfer'))<>'account_transfer'
      or not(lower(coalesce(r.status,'')) in ('approved','processing','owner_approved')
        or (r.status='resubmitted' and r.approval_status='RE_APPROVED')) then
      raise exception 'A selected request is no longer approved for bank processing.';
    end if;
    total:=round(coalesce(r.amount,r.amount_requested,0),2);
    paid:=coalesce(r.bank_paid_amount,0);
    if total<=paid or public.workforce_payout_bank_account_canonical(entry->>'credit_account')=''
      or public.workforce_payout_bank_ifsc_canonical(entry->>'ifsc')=''
      or paid is distinct from (entry->>'paid_amount')::numeric
      or total is distinct from (entry->>'approved_amount')::numeric
      or public.workforce_payout_bank_reference_canonical(r.request_no) is distinct from public.workforce_payout_bank_reference_canonical(entry->>'reference_no')
      or public.workforce_payout_bank_account_canonical(coalesce(nullif(r.beneficiary_account_number,''),nullif(r.beneficiary_account_no,''),r.bank_account_no)) is distinct from public.workforce_payout_bank_account_canonical(entry->>'credit_account')
      or public.workforce_payout_bank_ifsc_canonical(coalesce(nullif(r.beneficiary_ifsc,''),r.ifsc)) is distinct from public.workforce_payout_bank_ifsc_canonical(entry->>'ifsc') then
      raise exception 'Payment balance or beneficiary changed. Refresh the worksheet before downloading the bank file.';
    end if;
    update public.payment_requests set status='processing',approval_status='PROCESSING',
      processing_started_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=p_actor_user_id
      where company_id=p_company_id and id=r.id;
    select coalesce(max(sequence_no),0)+1 into seq from public.payment_request_approvals
      where company_id=p_company_id and (payment_request_id=r.id or request_id=r.id);
    insert into public.payment_request_approvals(company_id,request_id,payment_request_id,sequence_no,role_code,status,action,comments,approver_user_id,approval_cycle,created_at)
      values(p_company_id,r.id,r.id,seq,'BANK','processing','processing',
        'Bank transfer file generated for unpaid balance ₹'||(total-paid)||'; already paid ₹'||paid||'.',
        p_actor_user_id,coalesce(r.approval_cycle,1),clock_timestamp());
    prepared:=prepared+1;
  end loop;
  perform set_config('app.payment_request_bank_settlement',coalesce(old_flag,''),true);
  return jsonb_build_object('prepared',prepared);
end $$;
revoke all on function public.prepare_payment_request_bank_export(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_payment_request_bank_export(uuid,uuid,jsonb) to service_role;

do $patch$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='finalize_payment_request_bank_credit';
  if position('-- partial_cancel_balance_guard' in body)=0 then
    body:=replace(body,'  -- A failed remaining instalment never erases earlier successful credits.',
      '  -- A failed remaining instalment never erases earlier successful credits.'||chr(10)||
      '  -- partial_cancel_balance_guard'||chr(10)||
      '  old_flag:=current_setting(''app.payment_request_bank_settlement'',true);'||chr(10)||
      '  perform set_config(''app.payment_request_bank_settlement'',''allowed'',true);');
    body:=replace(body,'where company_id=p_company and id=r.id;',
      'where company_id=p_company and id=r.id;'||chr(10)||
      '  perform set_config(''app.payment_request_bank_settlement'',coalesce(old_flag,''''),true);');
    if position('-- partial_cancel_balance_guard' in body)=0 then raise exception 'Unexpected bank credit finalizer definition'; end if;
    execute body;
  end if;
end $patch$;

commit;
