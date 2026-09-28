-- DA selection is a reference, not an onboarding/mapping prerequisite.
-- A missing payroll identity must not prevent expense details or payment.
begin;
alter table public.payment_requests add column if not exists adhoc_recovery_checked_at timestamptz;
create index if not exists payment_adhoc_pending_recovery_idx on public.payment_requests(adhoc_recovery_checked_at nulls first,id)
where source_system='OPS_ADHOC_DA' and lower(status) in ('processed','paid') and adhoc_adjustment_id is null;

create or replace function public.resolve_adhoc_da_recovery_worker(company uuid, station uuid, provider_member text, scc_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare ids text[]; workers uuid[]; member text:=nullif(btrim(provider_member),'');
begin
  -- Manual SCC names may resolve only through a unique identity in the latest
  -- station roster, never by guessing a Workforce person with a similar name.
  if member is null then
    select array_agg(distinct btrim(s.provider_employee_id)) into ids
    from public.cps_shipment_daily s join public.stations t on t.company_id=s.company_id and t.station_code=s.station_code
    where s.company_id=company and t.id=station and lower(s.client)='amazon'
      and btrim(s.provider_employee_name)=btrim(scc_name) and nullif(btrim(s.provider_employee_id),'') is not null
      and s.work_date=(select max(d.work_date) from public.cps_shipment_daily d where d.company_id=company and d.station_code=t.station_code and lower(d.client)='amazon');
    if coalesce(cardinality(ids),0)<>1 then return null; end if;
    member:=ids[1];
  end if;
  if member ~* '^[0-9]+([.][0-9]+)?e[+-]?[0-9]+$' then return null; end if;
  select array_agg(distinct w.id) into workers
  from public.field_executive_provider_mappings m
  join public.providers p on p.id=m.provider_id and p.company_id=m.company_id
  join public.workforce w on w.company_id=m.company_id and
    (w.id=m.workforce_id or (m.workforce_id is null and (w.id=m.field_executive_id or w.source_profile_id=coalesce(m.contractor_id,m.employee_id,m.field_executive_id))))
  where m.company_id=company and m.station_id=station and btrim(m.provider_member_id)=member
    and m.status='active' and m.effective_from<=current_date and (m.effective_to is null or m.effective_to>=current_date)
    and lower(p.code)='amazon' and w.is_active=true and w.deleted_at is null and w.migration_state is distinct from 'reclassified';
  if coalesce(cardinality(workers),0)=1 then return workers[1]; end if;
  return null;
end $$;

create or replace function public.payment_adhoc_da_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare
  shipment public.cps_shipment_daily;
  station public.stations;
  captured boolean:=false;
  actor uuid; posting date; closed_end date; paid_amount numeric;
begin
  if tg_op='DELETE' then
    if old.source_system='OPS_ADHOC_DA' or old.adhoc_workforce_id is not null then raise exception 'Tracked Adhoc DA payments must be cancelled, not deleted'; end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    captured:=old.source_system='OPS_ADHOC_DA' and old.adhoc_da_name is not null;
    if captured then
      if row(new.company_id,new.location_id,new.payment_head_id,new.adhoc_shipment_id,new.adhoc_work_date,new.work_date,new.adhoc_workforce_id,new.adhoc_provider_employee_id,new.adhoc_da_name,new.adhoc_client,new.source_system)
        is distinct from row(old.company_id,old.location_id,old.payment_head_id,old.adhoc_shipment_id,old.adhoc_work_date,old.work_date,old.adhoc_workforce_id,old.adhoc_provider_employee_id,old.adhoc_da_name,old.adhoc_client,old.source_system) then
        raise exception 'Adhoc DA identity is frozen. Cancel the unpaid request and create a corrected request';
      end if;
      if new.adhoc_adjustment_id is distinct from old.adhoc_adjustment_id then raise exception 'Payroll deduction links are system managed'; end if;
      if lower(old.status) in ('processed','paid') and row(new.status,new.amount,new.amount_approved,new.amount_requested) is distinct from row(old.status,old.amount,old.amount_approved,old.amount_requested) then
        raise exception 'A paid Adhoc DA payment cannot be changed; use a reviewed payroll correction';
      end if;
    end if;
  end if;
  if new.source_system is distinct from 'OPS_ADHOC_DA' then
    if new.adhoc_shipment_id is not null or new.adhoc_workforce_id is not null or new.adhoc_adjustment_id is not null then raise exception 'Invalid Adhoc DA source'; end if;
    return new;
  end if;
  if not coalesce(captured,false) then
    if new.adhoc_adjustment_id is not null then raise exception 'Payroll deduction links are system managed'; end if;
    if not exists(select 1 from public.payment_heads where id=new.payment_head_id and company_id=new.company_id and code='ADHOC_DA') then raise exception 'DA selection is only for Adhoc DA / WM payment requests'; end if;
    select * into station from public.stations where company_id=new.company_id and id=new.location_id;
    if not found then raise exception 'Select a valid station'; end if;
    if new.adhoc_shipment_id is not null then
      select * into shipment from public.cps_shipment_daily where company_id=new.company_id and id=new.adhoc_shipment_id and station_code=station.station_code and lower(client)='amazon';
      if not found then raise exception 'Select a DA from the latest Amazon roster for this station'; end if;
      new.adhoc_provider_employee_id:=nullif(btrim(shipment.provider_employee_id),'');
      new.adhoc_da_name:=coalesce(nullif(btrim(shipment.provider_employee_name),''),new.adhoc_provider_employee_id);
    else
      new.adhoc_da_name:=nullif(btrim(new.adhoc_da_name),'');
      new.adhoc_provider_employee_id:=null;
    end if;
    if new.adhoc_da_name is null or length(new.adhoc_da_name)>160 then raise exception 'Paste the exact associate name shown in SCC (up to 160 characters)'; end if;
    new.adhoc_client:='Amazon';
    new.adhoc_work_date:=coalesce(new.adhoc_work_date,(now() at time zone 'Asia/Kolkata')::date);
    new.work_date:=new.adhoc_work_date;
    new.requested_for_name:=concat_ws(' / ',new.adhoc_da_name,new.adhoc_provider_employee_id);
    -- Never trust an identity submitted by a browser, including old forms.
    new.adhoc_workforce_id:=public.resolve_adhoc_da_recovery_worker(new.company_id,new.location_id,new.adhoc_provider_employee_id,new.adhoc_da_name);
  end if;
  if lower(new.status) in ('processed','paid') and new.adhoc_adjustment_id is null then
    paid_amount:=coalesce(new.amount,new.amount_requested);
    if paid_amount is null or paid_amount<=0 or paid_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'A positive paid amount is required'; end if;
    new.adhoc_recovery_checked_at:=now();
    if new.adhoc_workforce_id is null then
      new.adhoc_workforce_id:=public.resolve_adhoc_da_recovery_worker(new.company_id,new.location_id,new.adhoc_provider_employee_id,new.adhoc_da_name);
    end if;
    -- Persist paid/unmatched for reconciliation; never invent a payroll target.
    if new.adhoc_workforce_id is null then return new; end if;
    actor:=coalesce(new.updated_by,new.current_approver_user_id);
    if actor is null then raise exception 'A payment processor is required for the deduction audit'; end if;
    perform 1 from public.workforce where id=new.adhoc_workforce_id and company_id=new.company_id for update;
    posting:=new.adhoc_work_date;
    loop
      select max(r.period_end) into closed_end from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
      where r.company_id=new.company_id and i.workforce_id=new.adhoc_workforce_id and r.status in ('approved','paid') and posting between r.period_start and r.period_end;
      exit when closed_end is null;
      posting:=closed_end+1;
    end loop;
    insert into public.workforce_adjustments(company_id,workforce_id,adjustment_type,category,amount,effective_date,reason,external_reference,status,requested_by,reviewed_by,reviewed_at,review_remarks)
    values(new.company_id,new.adhoc_workforce_id,'deduction','cash_recovery',paid_amount,posting,
      concat('Adhoc DA already paid: ',new.request_no,' / ',new.adhoc_da_name,' / ',new.adhoc_provider_employee_id),
      'OPS-ADHOC-DA:'||new.id,'approved',null,actor,now(),'System recovery of Finance-processed payment; not an additional payment') returning id into new.adhoc_adjustment_id;
  end if;
  return new;
end $$;

create or replace function public.reconcile_adhoc_da_recoveries() returns jsonb
language plpgsql security definer set search_path='' as $$
declare item record; adjustment uuid; checked integer:=0; linked integer:=0; errors jsonb:='[]';
begin
  for item in select id from public.payment_requests
    where source_system='OPS_ADHOC_DA' and lower(status) in ('processed','paid') and adhoc_adjustment_id is null
    order by adhoc_recovery_checked_at nulls first,id limit 200 for update skip locked
  loop
    -- No payment status/amount changes. The guard performs idempotent recovery.
    checked:=checked+1;
    begin
      update public.payment_requests set adhoc_recovery_checked_at=now() where id=item.id returning adhoc_adjustment_id into adjustment;
      if adjustment is not null then linked:=linked+1; end if;
    exception when others then
      errors:=errors||jsonb_build_array(jsonb_build_object('id',item.id,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('checked',checked,'linked',linked,'unmatched',checked-linked-jsonb_array_length(errors),'errors',errors);
end $$;
revoke all on function public.resolve_adhoc_da_recovery_worker(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.payment_adhoc_da_guard() from public,anon,authenticated;
revoke all on function public.reconcile_adhoc_da_recoveries() from public,anon,authenticated;
grant execute on function public.reconcile_adhoc_da_recoveries() to service_role;
notify pgrst,'reload schema';
commit;
