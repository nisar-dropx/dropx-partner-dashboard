-- New explicitly dated ad hoc requests exclude a paid day, not a second cash deduction.
-- Existing requests/adjustments and finalized payrolls retain their historical policy.
begin;
alter table public.payment_requests add column if not exists adhoc_payout_policy text not null default 'cash_recovery';
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.payment_requests'::regclass and conname='payment_adhoc_payout_policy_check') then
    alter table public.payment_requests add constraint payment_adhoc_payout_policy_check check(adhoc_payout_policy in ('cash_recovery','work_day'));
  end if;
end $$;
create index if not exists payment_adhoc_paid_work_day_idx on public.payment_requests(company_id,location_id,adhoc_work_date)
where source_system='OPS_ADHOC_DA' and adhoc_payout_policy='work_day' and lower(status) in ('processed','paid');
create index if not exists cps_adhoc_roster_idx on public.cps_shipment_daily(company_id,station_code,client,provider_employee_id,work_date desc);

create or replace function public.payment_adhoc_da_roster(p_company_id uuid,p_station_id uuid)
returns table(shipment_id uuid,provider_member_id text,associate_name text)
language sql stable security definer set search_path='' as $$
  select x.id,x.provider_employee_id,x.provider_employee_name from (
    select distinct on(s.provider_employee_id) s.id,s.provider_employee_id,s.provider_employee_name
    from public.cps_shipment_daily s join public.stations t on t.company_id=s.company_id and t.station_code=s.station_code
    join public.providers p on p.company_id=t.company_id and p.id=t.provider_id
    where t.company_id=p_company_id and t.id=p_station_id and nullif(btrim(s.provider_employee_id),'') is not null
      and ((lower(p.code || ' ' || p.name) like '%flipkart%' and lower(s.client)='flipkart' and s.provider_employee_id ~ '^[0-9]{12}$')
        or (lower(p.code || ' ' || p.name) like '%amazon%' and lower(s.client)='amazon'))
    order by s.provider_employee_id,s.work_date desc,s.id
  ) x order by x.provider_employee_name nulls last,x.provider_employee_id;
$$;
create or replace function public.resolve_adhoc_paid_day_worker(company uuid,station uuid,client_name text,member text,day date)
returns uuid language sql stable security definer set search_path='' as $$
  select case when count(distinct w.id)=1 then min(w.id::text)::uuid else null end
  from public.field_executive_provider_mappings m join public.providers p on p.company_id=m.company_id and p.id=m.provider_id
  join public.workforce w on w.company_id=m.company_id and (w.id=m.workforce_id or (m.workforce_id is null and (w.id=m.field_executive_id or w.source_profile_id=coalesce(m.contractor_id,m.employee_id,m.field_executive_id))))
  where m.company_id=company and m.station_id=station and upper(btrim(m.provider_member_id))=upper(btrim(member))
    and (lower(p.code)=lower(client_name) or lower(p.name)=lower(client_name))
    and m.status in ('active','closed') and m.effective_from<=day and (m.effective_to is null or m.effective_to>=day);
$$;
create or replace function public.payment_adhoc_da_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare
  shipment public.cps_shipment_daily;
  station public.stations;
  captured boolean:=false;
  actor uuid; posting date; closed_end date; paid_amount numeric; provider_code text;
begin
  if tg_op='DELETE' then
    if old.source_system='OPS_ADHOC_DA' or old.adhoc_workforce_id is not null then raise exception 'Tracked Adhoc DA payments must be cancelled, not deleted'; end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    captured:=old.source_system='OPS_ADHOC_DA' and old.adhoc_da_name is not null;
    if captured then
      if new.adhoc_payout_policy is distinct from old.adhoc_payout_policy then raise exception 'Adhoc payout policy is frozen'; end if;
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
    select lower(p.code || ' ' || p.name) into provider_code from public.providers p where p.company_id=station.company_id and p.id=station.provider_id;
    if new.adhoc_payout_policy='work_day' and coalesce(provider_code,'') not like '%amazon%' and coalesce(provider_code,'') not like '%flipkart%' then raise exception 'Configure the station provider before selecting an associate'; end if;
    new.adhoc_client:=case when provider_code like '%flipkart%' then 'Flipkart' else 'Amazon' end;
    if new.adhoc_shipment_id is not null then
      select * into shipment from public.cps_shipment_daily where company_id=new.company_id and id=new.adhoc_shipment_id and station_code=station.station_code and lower(client)=lower(new.adhoc_client);
      if not found then raise exception 'Select an imported associate from this station and provider'; end if;
      new.adhoc_provider_employee_id:=nullif(btrim(shipment.provider_employee_id),'');
      new.adhoc_da_name:=coalesce(nullif(btrim(shipment.provider_employee_name),''),new.adhoc_provider_employee_id);
    else
      new.adhoc_da_name:=nullif(btrim(new.adhoc_da_name),'');
      new.adhoc_provider_employee_id:=case when new.adhoc_payout_policy='work_day' then nullif(btrim(new.adhoc_provider_employee_id),'') else null end;
    end if;
    if new.adhoc_da_name is null or length(new.adhoc_da_name)>160 then raise exception 'Paste the exact associate name shown in SCC (up to 160 characters)'; end if;
    if new.adhoc_payout_policy='work_day' then
      if new.adhoc_provider_employee_id is null then raise exception 'An associate provider ID is required'; end if;
      if new.adhoc_client='Flipkart' and new.adhoc_provider_employee_id !~ '^[0-9]{12}$' then raise exception 'Enter the 12-digit FHR ID from Casper'; end if;
      if new.adhoc_provider_employee_id !~ '^[A-Za-z0-9_-]{2,40}$' then raise exception 'Enter a valid provider ID'; end if;
      if new.adhoc_work_date is null then raise exception 'Choose the date this associate worked'; end if;
    end if;
    new.adhoc_work_date:=coalesce(new.adhoc_work_date,(now() at time zone 'Asia/Kolkata')::date);
    new.work_date:=new.adhoc_work_date;
    new.requested_for_name:=concat_ws(' / ',new.adhoc_da_name,new.adhoc_provider_employee_id);
    -- Never trust an identity submitted by a browser, including old forms.
    new.adhoc_workforce_id:=case when new.adhoc_payout_policy='work_day'
      then public.resolve_adhoc_paid_day_worker(new.company_id,new.location_id,new.adhoc_client,new.adhoc_provider_employee_id,new.adhoc_work_date)
      else public.resolve_adhoc_da_recovery_worker(new.company_id,new.location_id,new.adhoc_provider_employee_id,new.adhoc_da_name) end;
  end if;
  if new.adhoc_payout_policy='work_day' then
    if new.adhoc_adjustment_id is not null then raise exception 'Paid-day requests cannot also have a cash recovery'; end if;
    -- Serialize against payroll publication/payment checks and other ad hoc payments.
    perform public.lock_workforce_payment_allocation_company(new.company_id);
    if lower(new.status) in ('processed','paid') and (tg_op='INSERT' or lower(old.status) not in ('processed','paid')) then
      if coalesce(new.amount,new.amount_requested,0)<=0 then raise exception 'A positive paid amount is required'; end if;
      if exists(select 1 from public.payment_requests r where r.company_id=new.company_id and r.location_id=new.location_id
        and lower(r.adhoc_client)=lower(new.adhoc_client) and upper(btrim(r.adhoc_provider_employee_id))=upper(btrim(new.adhoc_provider_employee_id))
        and r.adhoc_work_date=new.adhoc_work_date and r.id<>new.id and lower(r.status) in ('processed','paid') and r.source_system='OPS_ADHOC_DA') then
        raise exception 'This associate already has a paid ad hoc request for this location and work date';
      end if;
      new.adhoc_workforce_id:=public.resolve_adhoc_paid_day_worker(new.company_id,new.location_id,new.adhoc_client,new.adhoc_provider_employee_id,new.adhoc_work_date);
      if exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=new.company_id and a.credited_workforce_id=new.adhoc_workforce_id
        and a.station_id=new.location_id and new.adhoc_work_date between a.period_start and a.period_end)
        or exists(select 1 from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
          where r.company_id=new.company_id and i.workforce_id=new.adhoc_workforce_id and r.status in ('approved','paid') and i.status<>'excluded' and new.adhoc_work_date between r.period_start and r.period_end) then
        raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
      end if;
      perform public.workforce_bump_payout_period_dependency_revision(new.company_id,new.adhoc_work_date);
      perform public.enqueue_workforce_payout_dependency_refresh(new.company_id,new.adhoc_workforce_id,new.location_id,new.adhoc_work_date,new.adhoc_work_date,new.updated_by);
    end if;
    -- The calculation excludes the paid day. Never also create a cash recovery.
    return new;
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
    where source_system='OPS_ADHOC_DA' and lower(status) in ('processed','paid') and adhoc_adjustment_id is null and adhoc_payout_policy='cash_recovery'
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
revoke all on function public.payment_adhoc_da_roster(uuid,uuid),public.resolve_adhoc_paid_day_worker(uuid,uuid,text,text,date),public.payment_adhoc_da_guard(),public.reconcile_adhoc_da_recoveries() from public,anon,authenticated;
grant execute on function public.payment_adhoc_da_roster(uuid,uuid),public.reconcile_adhoc_da_recoveries() to service_role;
notify pgrst,'reload schema';
commit;
