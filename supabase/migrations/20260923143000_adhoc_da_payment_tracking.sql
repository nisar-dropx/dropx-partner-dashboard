begin;

-- Snapshot identity, not a live FK to re-importable shipment records. Historical
-- unlinked requests are deliberately not guessed/backfilled or deducted.
alter table public.payment_requests
  add column adhoc_shipment_id uuid,
  add column adhoc_work_date date,
  add column adhoc_provider_employee_id text,
  add column adhoc_da_name text,
  add column adhoc_client text,
  add column adhoc_workforce_id uuid references public.workforce(id),
  add column adhoc_adjustment_id uuid unique references public.workforce_adjustments(id);
create index payment_adhoc_da_report_idx on public.payment_requests(company_id,location_id,adhoc_work_date) where adhoc_workforce_id is not null;
create unique index workforce_adhoc_payment_reference_idx on public.workforce_adjustments(company_id,external_reference) where external_reference like 'OPS-ADHOC-DA:%';

create function public.payment_adhoc_da_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare shipment public.cps_shipment_daily; station public.stations; workers uuid[]; actor uuid; posting date; closed_end date; paid_amount numeric;
begin
  if tg_op='DELETE' then
    if old.adhoc_workforce_id is not null then raise exception 'Tracked Adhoc DA payments must be cancelled, not deleted'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.adhoc_workforce_id is not null then
    if new.work_date is distinct from old.work_date then raise exception 'Adhoc DA work date is frozen with the selected shipment record'; end if;
    if row(new.company_id,new.location_id,new.payment_head_id,new.adhoc_shipment_id,new.adhoc_work_date,new.adhoc_workforce_id,new.adhoc_provider_employee_id,new.adhoc_da_name,new.adhoc_client,new.source_system)
       is distinct from row(old.company_id,old.location_id,old.payment_head_id,old.adhoc_shipment_id,old.adhoc_work_date,old.adhoc_workforce_id,old.adhoc_provider_employee_id,old.adhoc_da_name,old.adhoc_client,old.source_system) then
      raise exception 'Adhoc DA identity is frozen. Cancel the unpaid request and create a corrected request';
    end if;
    if new.adhoc_adjustment_id is distinct from old.adhoc_adjustment_id then raise exception 'Payroll deduction links are system managed'; end if;
    if old.adhoc_adjustment_id is not null and row(new.status,new.amount,new.amount_approved,new.amount_requested) is distinct from row(old.status,old.amount,old.amount_approved,old.amount_requested) then
      raise exception 'A paid Adhoc DA payment cannot be changed; use a reviewed payroll correction';
    end if;
  end if;
  if new.source_system is distinct from 'OPS_ADHOC_DA' then
    if new.adhoc_shipment_id is not null or new.adhoc_workforce_id is not null or new.adhoc_adjustment_id is not null then raise exception 'Invalid Adhoc DA source'; end if;
    return new;
  end if;
  if tg_op='INSERT' or old.adhoc_workforce_id is null then
    if new.adhoc_adjustment_id is not null then raise exception 'Payroll deduction links are system managed'; end if;
    if not exists(select 1 from public.payment_heads where id=new.payment_head_id and company_id=new.company_id and code='ADHOC_DA') then raise exception 'DA selection is only for Adhoc DA / WM payment requests'; end if;
    select * into station from public.stations where company_id=new.company_id and id=new.location_id;
    select * into shipment from public.cps_shipment_daily where company_id=new.company_id and id=new.adhoc_shipment_id and station_code=station.station_code and work_date=new.adhoc_work_date;
    if not found or nullif(btrim(shipment.provider_employee_id),'') is null then raise exception 'Select a DA from this station and work date'; end if;
    -- Scientific-notation IDs are lossy import data: never guess a financial identity.
    if shipment.provider_employee_id ~* '^[0-9]+([.][0-9]+)?e[+-]?[0-9]+$' then raise exception 'Provider ID is in scientific notation. Correct the source import before payment'; end if;
    select array_agg(distinct w.id) into workers
      from public.field_executive_provider_mappings m
      join public.providers p on p.id=m.provider_id and p.company_id=m.company_id
      join public.workforce w on w.company_id=m.company_id and
        (w.id=m.workforce_id or (m.workforce_id is null and (w.id=m.field_executive_id or w.source_profile_id=coalesce(m.contractor_id,m.employee_id,m.field_executive_id))))
      where m.company_id=new.company_id and m.station_id=new.location_id and m.provider_member_id=shipment.provider_employee_id
        and m.status<>'cancelled' and m.effective_from<=shipment.work_date and (m.effective_to is null or m.effective_to>=shipment.work_date)
        and lower(shipment.client) in (lower(p.code),lower(p.name)) and w.deleted_at is null and w.migration_state<>'reclassified';
    if coalesce(cardinality(workers),0)<>1 then raise exception 'This DA ID needs one valid Workforce mapping for the selected station/date. Correct Provider Mapping before submitting payment'; end if;
    new.adhoc_workforce_id:=workers[1]; new.adhoc_provider_employee_id:=shipment.provider_employee_id;
    new.adhoc_da_name:=coalesce(nullif(btrim(shipment.provider_employee_name),''),shipment.provider_employee_id);
    new.adhoc_client:=shipment.client; new.work_date:=shipment.work_date;
    new.requested_for_name:=new.adhoc_da_name||' / '||new.adhoc_provider_employee_id;
  end if;
  if lower(new.status) in ('processed','paid') and new.adhoc_adjustment_id is null then
    paid_amount:=coalesce(new.amount,new.amount_requested);
    if paid_amount is null or paid_amount<=0 or paid_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'A positive paid amount is required'; end if;
    actor:=coalesce(new.updated_by,new.current_approver_user_id);
    if actor is null then raise exception 'A payment processor is required for the deduction audit'; end if;
    perform 1 from public.workforce where id=new.adhoc_workforce_id and company_id=new.company_id for update;
    posting:=new.adhoc_work_date;
    -- Never mutate a closed payroll. Carry a late payment to the next open day.
    loop
      select max(r.period_end) into closed_end from public.workforce_payroll_runs r join public.workforce_payroll_items i on i.payroll_run_id=r.id and i.company_id=r.company_id
      where r.company_id=new.company_id and i.workforce_id=new.adhoc_workforce_id and r.status in ('approved','paid') and posting between r.period_start and r.period_end;
      exit when closed_end is null;
      posting:=closed_end+1;
    end loop;
    insert into public.workforce_adjustments(company_id,workforce_id,adjustment_type,category,amount,effective_date,reason,external_reference,status,requested_by,reviewed_by,reviewed_at,review_remarks)
      values(new.company_id,new.adhoc_workforce_id,'deduction','cash_recovery',paid_amount,posting,
        'Adhoc DA already paid: '||new.request_no||' / '||new.adhoc_da_name||' / '||new.adhoc_provider_employee_id||' / work date '||new.adhoc_work_date,
        'OPS-ADHOC-DA:'||new.id,'approved',null,actor,now(),'System recovery of Finance-processed payment; not an additional payment') returning id into new.adhoc_adjustment_id;
  end if;
  return new;
end $$;
create trigger payment_adhoc_da_guard before insert or update or delete on public.payment_requests for each row execute function public.payment_adhoc_da_guard();

create function public.workforce_adhoc_deduction_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(old.external_reference,'') not like 'OPS-ADHOC-DA:%' then return case when tg_op='DELETE' then old else new end; end if;
  if tg_op='DELETE' then raise exception 'Paid Adhoc DA deductions cannot be deleted'; end if;
  if row(new.company_id,new.workforce_id,new.amount,new.adjustment_type,new.category,new.effective_date,new.reason,new.external_reference,new.reviewed_by,new.reviewed_at,new.requested_by)
    is distinct from row(old.company_id,old.workforce_id,old.amount,old.adjustment_type,old.category,old.effective_date,old.reason,old.external_reference,old.reviewed_by,old.reviewed_at,old.requested_by)
    or new.status not in ('approved','posted') then raise exception 'Paid Adhoc DA deductions are immutable; use a reviewed correction'; end if;
  return new;
end $$;
create trigger workforce_adhoc_deduction_guard before update or delete on public.workforce_adjustments for each row execute function public.workforce_adhoc_deduction_guard();

create function public.workforce_adhoc_payroll_gate() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('review','approved','paid') and new.status<>old.status then
    perform 1 from public.workforce w join public.workforce_payroll_items i on i.workforce_id=w.id and i.company_id=w.company_id where i.payroll_run_id=new.id and i.status<>'excluded' order by w.id for update of w;
    if exists(select 1 from public.workforce_adjustments a join public.workforce_payroll_items i on i.workforce_id=a.workforce_id and i.company_id=a.company_id
      where i.payroll_run_id=new.id and i.status<>'excluded' and a.external_reference like 'OPS-ADHOC-DA:%' and a.status='approved' and a.payroll_run_id is null and a.effective_date between new.period_start and new.period_end) then
      raise exception 'A paid Adhoc DA deduction is missing from this payroll. Return to draft and recalculate before confirmation';
    end if;
  end if;
  return new;
end $$;
create trigger workforce_adhoc_payroll_gate before update of status on public.workforce_payroll_runs for each row execute function public.workforce_adhoc_payroll_gate();
revoke all on function public.payment_adhoc_da_guard(),public.workforce_adhoc_deduction_guard(),public.workforce_adhoc_payroll_gate() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
