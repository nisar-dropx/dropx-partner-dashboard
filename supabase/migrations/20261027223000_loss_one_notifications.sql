begin;
-- Assignment notice only. Never marks money deducted or publishes payroll.
create or replace function public.notify_loss_recovery_assignment(p public.nl_loss_recoveries)
returns void language plpgsql security invoker set search_path=public as $$
declare a jsonb; kind text; person uuid; shipment text;
begin
 if p.is_deleted or p.approval_status not in ('approved','proposed') then return; end if;
 select coalesce(nullif(details->>'tid',''),case_key) into shipment from public.nl_loss_month_cases
 where company_id=p.company_id and month=p.month and case_key=p.case_key;
 for a in select value from jsonb_array_elements(coalesce(p.allocations,'[]')) loop
  kind:=split_part(a->>'ref',':',1);
  if kind not in ('employee','contractor','workforce') then continue; end if;
  person:=split_part(a->>'ref',':',2)::uuid;
  insert into public.mob_app_notifications(company_id,recipient_profile_type,recipient_account_id,event_code,source_key,title,body,route,data)
  values(p.company_id,kind,person,'LOSS_RECOVERY_UPDATED',p.month||'|'||p.case_key||'|'||p.version||'|'||kind,
   'Loss recovery updated',
   'Shipment '||coalesce(shipment,p.case_key)||' · Your share ₹'||(a->>'amount')||case when p.approval_status='approved' then ' · Eligible payroll '||coalesce(p.deduction_month,'pending') else ' · Awaiting approval' end||'. Open for the shipment value, your share and deduction history.',
   case when kind='workforce' then 'payments' else 'salary' end,
   jsonb_build_object('lossMonth',p.month,'caseKey',p.case_key,'shipmentId',shipment,'assignedAmount',a->'amount','payrollMonth',p.deduction_month,'showOnDashboard',true,'dashboardUntil',now()+interval '7 days'))
  on conflict(company_id,event_code,source_key,recipient_account_id) do nothing;
 end loop;
end $$;
create or replace function public.loss_recovery_assignment_notice_trigger()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 perform public.notify_loss_recovery_assignment(new);
 return new;
end $$;
drop trigger if exists loss_recovery_assignment_notice on public.nl_loss_recoveries;
create trigger loss_recovery_assignment_notice after insert or update on public.nl_loss_recoveries
for each row execute function public.loss_recovery_assignment_notice_trigger();
revoke all on function public.notify_loss_recovery_assignment(public.nl_loss_recoveries),public.loss_recovery_assignment_notice_trigger() from public,anon,authenticated;
grant execute on function public.notify_loss_recovery_assignment(public.nl_loss_recoveries),public.loss_recovery_assignment_notice_trigger() to service_role;
-- Notify existing assigned plans once, using the same versioned idempotency key.
select public.notify_loss_recovery_assignment(r) from public.nl_loss_recoveries r
where not r.is_deleted and r.approval_status in ('approved','proposed') and r.deduction_month >= '2026-10';
commit;
