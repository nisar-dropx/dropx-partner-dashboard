-- Administrator-run reconciliation of bank payments already made outside OpsPulse.
-- Supply app.historical_settlements JSON transaction-locally; never commit bank data.
-- Does not send money or produce a bank file. Retains publication and bank evidence.
-- Run first with dry_run=true: the expected exception rolls back every change.
do $reconcile$
declare
 p jsonb := current_setting('app.historical_settlements')::jsonb;
 co uuid := (p->>'company_id')::uuid;
 actor uuid := (p->>'actor_id')::uuid;
 r jsonb; w public.workforce%rowtype; pub public.workforce_payout_publications%rowtype;
 bank public.payment_banks%rowtype; existing public.workforce_payout_payment_items%rowtype;
 batch uuid; item uuid; version integer; reference text; utr text;
 paid numeric; target numeric; amount numeric; instruction numeric;
 posted integer := 0; skipped integer := 0; total numeric := 0;
 result jsonb := '[]';
begin
 if p->>'file_sha256' !~ '^[a-f0-9]{64}$' or jsonb_array_length(p->'rows')=0
   or not exists(select 1 from auth.users where id=actor) then
  raise exception 'Verified file, actor and rows are required';
 end if;
 perform 1 from public.workforce where company_id=co
  and id in(select (x->>'workforce_id')::uuid from jsonb_array_elements(p->'rows') x)
  order by id for update;
 perform public.lock_workforce_payment_allocation_company(co);
 for r in select value from jsonb_array_elements(p->'rows') loop
  amount := (r->>'amount')::numeric;
  if amount<=0 or amount<>round(amount,2) then raise exception 'Invalid amount, row %',r->>'row'; end if;
  if r->>'ifsc' !~ '^[A-Z]{4}0[A-Z0-9]{6}$' or r->>'credit_account' !~ '^[A-Z0-9]{4,30}$' then
   raise exception 'Invalid beneficiary bank evidence, row %',r->>'row';
  end if;
  utr := regexp_replace(upper(r->>'utr'),'[^A-Z0-9]','','g');
  if length(utr)<6 then raise exception 'Invalid UTR, row %',r->>'row'; end if;
  select * into strict w from public.workforce where company_id=co
   and id=(r->>'workforce_id')::uuid and dropx_id=r->>'dropx_id';
  -- Claim serialization matches the central paid-UTR guard.
  perform pg_advisory_xact_lock(hashtextextended('central-bank-paid-utr:'||co::text||':'||utr,0));
  select * into existing from public.workforce_payout_payment_items
   where company_id=co and status='paid' and regexp_replace(upper(utr_cin),'[^A-Z0-9]','','g')=utr;
  if found then
   if existing.workforce_id<>w.id or existing.settled_amount<>amount
     or existing.period_start<>(p->>'period_start')::date then
    raise exception 'UTR conflicts with an existing payment, row %',r->>'row';
   end if;
   skipped:=skipped+1;
   result:=result||jsonb_build_array(jsonb_build_object('row',r->'row','status','duplicate_skipped','item_id',existing.id));
   continue;
  end if;
  if exists(select 1 from public.payout_bank_paid_transaction_registry where company_id=co and normalized_utr=utr)
   or exists(select 1 from public.central_bank_paid_transaction_registry where company_id=co and normalized_utr=utr)
   or exists(select 1 from public.hr_payroll_bank_lines b where b.company_id=co and b.status='paid' and regexp_replace(upper(b.utr),'[^A-Z0-9]','','g')=regexp_replace(upper(r->>'utr'),'[^A-Z0-9]','','g')) then
   raise exception 'UTR already exists in another payment ledger, row %',r->>'row';
  end if;
  select * into strict pub from public.workforce_payout_publications
   where company_id=co and id=(r->>'publication_id')::uuid and workforce_id=w.id
    and period_start=(p->>'period_start')::date and period_end=(p->>'period_end')::date
    and publication_kind='worksheet' and snapshot_hash=r->>'snapshot_hash';
  target := (pub.snapshot->'item'->>'net_amount')::numeric;
  if target<>(r->>'target')::numeric then raise exception 'Publication value changed, row %',r->>'row'; end if;
  if exists(select 1 from public.workforce_payout_payment_items where company_id=co and workforce_id=w.id
    and period_start=pub.period_start and period_end=pub.period_end and status='processing') then
   raise exception 'Existing payment processing, row %',r->>'row';
  end if;
  select coalesce(sum(settled_amount_snapshot),0) into paid
   from public.workforce_payout_effective_paid_allocations
   where company_id=co and credited_workforce_id=w.id and station_id=pub.station_id
    and period_start=pub.period_start and period_end=pub.period_end;
  instruction := round(target-paid,2);
  if amount>instruction then raise exception 'Payment exceeds reconciled publication balance, row %',r->>'row'; end if;
  select * into strict bank from public.payment_banks where company_id=co and id=(p->>'bank_id')::uuid
   and public.workforce_payout_bank_account_canonical(account_no)=r->>'debit_account';
  select coalesce(max(payment_version),0)+1 into version from public.workforce_payout_payment_items
   where company_id=co and (workforce_id=w.id or dropx_id_snapshot=w.dropx_id)
    and period_start=pub.period_start and period_end=pub.period_end;
  reference:=public.workforce_payout_payment_reference(w.dropx_id,pub.period_start,version);
  batch:=gen_random_uuid(); item:=gen_random_uuid();
  perform set_config('app.workforce_payout_payment_mutation','allowed',true);
  insert into public.workforce_payout_payment_batches(id,company_id,operation_id,request_fingerprint,
   selected_workforce_ids,bank_id,period_start,period_end,value_date,debit_account_no_snapshot,
   bank_code_snapshot,file_type_snapshot,status,generated_by)
  values(batch,co,(r->>'batch_operation')::uuid,p->>'file_sha256',array[w.id],bank.id,
   pub.period_start,pub.period_end,(r->>'value_date')::date,r->>'debit_account',bank.bank_code,'fedone','processing',actor);
  insert into public.workforce_payout_payment_items(id,company_id,batch_id,workforce_id,period_start,period_end,
   payment_version,reference_no,dropx_id_snapshot,beneficiary_name_snapshot,bank_account_no_snapshot,ifsc_snapshot,
   location_id_snapshot,location_code_snapshot,debit_remarks_snapshot,credit_remarks_snapshot,
   current_target_amount,paid_before_amount,instruction_amount,status)
  values(item,co,batch,w.id,pub.period_start,pub.period_end,version,reference,w.dropx_id,w.full_name,
   r->>'credit_account',r->>'ifsc',pub.station_id,pub.snapshot->'item'->>'station_code','NET PAY',w.dropx_id,
   target,paid,instruction,'processing');
  insert into public.workforce_payout_payment_allocations(company_id,payment_item_id,publication_id,station_id,revision,
   mapping_relock_id,snapshot_hash,station_code_snapshot,net_amount_snapshot,instruction_amount_snapshot)
  values(co,item,pub.id,pub.station_id,pub.revision,pub.mapping_relock_id,pub.snapshot_hash,
   pub.snapshot->'item'->>'station_code',target,instruction);
  insert into public.workforce_payout_payment_events(company_id,batch_id,payment_item_id,event_type,event_data,actor_user_id)
  values(co,batch,item,'payment_instruction_created',jsonb_build_object('source','historical_bank_reconciliation',
   'file_name',p->>'file_name','file_sha256',p->>'file_sha256','source_row',r->'row',
   'publication_id',pub.id,'reference_no',reference,'instruction_amount',instruction,
   'bank_file_generated',false,'notes',r->>'notes'),actor);
  perform public.workforce_finalize_payout_payment_item_manually(co,actor,(r->>'settlement_operation')::uuid,item,
   amount,r->>'debit_account',r->>'credit_account',r->>'ifsc',(r->>'value_date')::date,r->>'utr',
   'Paid outside OpsPulse; bank evidence supplied by Jamsheer',
   format('Historical %s salary. %s row %s; SHA256 %s. %s',p->>'period_start',p->>'file_name',r->>'row',p->>'file_sha256',r->>'notes'));
  posted:=posted+1; total:=total+amount;
  result:=result||jsonb_build_array(jsonb_build_object('row',r->'row','status','posted','item_id',item,'amount',amount));
 end loop;
 -- Optional policy change is atomic with the reconciliation and audited by nl_master_audit.
 if p ? 'payroll_start_month' then
  if p->>'payroll_start_month' <> to_char((p->>'period_start')::date,'YYYY-MM') then
   raise exception 'Payroll boundary must match the reconciled month';
  end if;
  update public.nl_loss_sources set recovery_policy=jsonb_set(recovery_policy,'{payroll_start_month}',p->'payroll_start_month'),
   updated_by=actor,updated_at=clock_timestamp()
   where company_id=co and recovery_policy->>'payroll_start_month' is distinct from p->>'payroll_start_month';
 end if;
 set constraints all immediate;
 if coalesce((p->>'dry_run')::boolean,true) then
  raise exception 'DRY RUN SUCCESS: % posted, % skipped, amount %. All writes rolled back.',posted,skipped,total;
 end if;
 perform set_config('app.historical_settlement_result',jsonb_build_object('posted',posted,'skipped',skipped,'amount',total,'rows',result)::text,true);
end $reconcile$;
