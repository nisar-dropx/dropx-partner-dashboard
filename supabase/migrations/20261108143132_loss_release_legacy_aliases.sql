-- Ignore only obsolete spreadsheet aliases without financial or response history.
create or replace function public.loss_payment_release_review(p_company uuid,p_station uuid,p_month text,p_scope text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_code text; v_codes text[]; v_cases jsonb; v_due jsonb:='[]'; v_payroll jsonb:='[]';
 v_missing jsonb:='[]'; v_pending jsonb; v_hash text; v_approval jsonb; v_run uuid;
begin
 if p_month is null or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then raise exception 'Choose a valid salary month.'; end if;
 if p_scope not in ('workforce','helpers') and p_scope !~ '^people:[0-9a-f-]{36}$' then raise exception 'Choose a valid payroll source.'; end if;
 select s.station_code,array_remove(array[s.station_code,cs.portal_station_code],null) into v_code,v_codes
 from public.stations s left join public.cod_station_settings cs on cs.company_id=s.company_id and cs.location_id=s.id
 where s.company_id=p_company and s.id=p_station;
 if v_code is null then raise exception 'Payroll station is missing or outside the company.'; end if;
 -- Include older unresolved cases and salary allocations regardless of the case's source period.
 select coalesce(jsonb_agg(jsonb_build_object('report',c.report,'month',c.month,'reference',c.case_key,
  'amount',c.amount,'status',case when not c.source_present then 'Missing from latest source' else initcap(replace(c.lifecycle_status,'_',' ')) end,'present',c.source_present,'sourceStatus',c.source_status,
  'final',c.final_seen_at is not null,'period',c.details->>'period',
  'plan',case when r.case_key is null then null else to_jsonb(r)-array['updated_at','assigned_at'] end,
  'response',case when rw.case_key is null then null else to_jsonb(rw)-array['updated_at'] end,
  'pending',c.lifecycle_status not in ('recovered','written_off','rejected','not_recoverable')
    and (not c.source_present or not coalesce(public.nl_case_recoverable(p_company,c.report,c.source_status),false) or r.case_key is null or r.is_deleted or r.approval_status is distinct from 'approved'
      or round(r.source_amount,2)<>round(c.amount,2)
      or public.nl_recovery_source_status_key(r.source_status) is distinct from public.nl_recovery_source_status_key(c.source_status)
      or c.lifecycle_status not in ('recovery_approved_scheduled','recovery_in_progress','exit_balance')
      or (c.report='slp' and c.final_seen_at is null))
 ) order by c.month,c.case_key),'[]'::jsonb) into v_cases
 from public.nl_loss_month_cases c
 left join public.nl_loss_recoveries r on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key
 left join public.nl_case_response_windows rw on rw.company_id=c.company_id and rw.month=c.month and rw.case_key=c.case_key
 where c.company_id=p_company and upper(c.station_code)=any(select upper(unnest(v_codes))) and c.month<=p_month
 and not (not c.source_present and c.case_key ~ '^=[0-9]+$' and r.case_key is null and rw.case_key is null
   and exists(select 1 from public.nl_loss_month_cases canonical where canonical.company_id=c.company_id
     and canonical.month=c.month and canonical.report=c.report and upper(canonical.station_code)=upper(c.station_code)
     and canonical.case_key=substring(c.case_key from 2) and canonical.source_present
     and canonical.amount=c.amount
     and public.nl_recovery_source_status_key(canonical.source_status) is not distinct from public.nl_recovery_source_status_key(c.source_status)));
 select coalesce(jsonb_agg(c),'[]'::jsonb) into v_pending from jsonb_array_elements(v_cases) c where (c->>'pending')::boolean;
 if p_scope='workforce' then
   select coalesce(jsonb_agg(jsonb_build_object('worker',x.workforce_id,'station',x.station_id,
     'item',x.snapshot->'item','deductions',x.snapshot#>'{worksheet,deduction_breakdown}') order by x.workforce_id,x.station_id),'[]'::jsonb)
   into v_payroll from (
     select distinct on (w.workforce_id,w.station_id) w.* from public.workforce_payout_publications w
     where w.company_id=p_company and w.period_start=to_date(p_month,'YYYY-MM')
       and w.period_end=(to_date(p_month,'YYYY-MM')+interval '1 month - 1 day')::date
       and w.workforce_id in (select workforce_id from public.workforce_payout_publications where company_id=p_company and station_id=p_station and period_start=to_date(p_month,'YYYY-MM'))
     order by w.workforce_id,w.station_id,w.revision desc
   ) x;
   select coalesce(jsonb_agg(to_jsonb(d) order by d.recovery_key),'[]'::jsonb) into v_due
   from public.nl_loss_recovery_due(p_company,p_month,'workforce') d
   where d.worker_id::text in (select v->>'worker' from jsonb_array_elements(v_payroll) v);
   select coalesce(jsonb_agg(jsonb_build_object('reference',d->>'recovery_key','worker',d->>'full_name','amount',(d->>'amount')::numeric)),'[]'::jsonb)
   into v_missing from jsonb_array_elements(v_due) d
   where (select coalesce(sum((line->>'amount')::numeric),0) from jsonb_array_elements(v_payroll) pay
     cross join lateral jsonb_array_elements(coalesce(pay->'deductions','[]')) line
     where pay->>'worker'=d->>'worker_id' and line->>'recoveryKey'=d->>'recovery_key')<>(d->>'amount')::numeric;
 elsif p_scope='helpers' then
   select coalesce(jsonb_agg(jsonb_build_object('worker',x.helper_id,'item',x.snapshot->'item','worksheet',x.snapshot->'worksheet') order by x.helper_id),'[]'::jsonb)
   into v_payroll from (select distinct on (helper_id) * from public.helper_payout_publications
     where company_id=p_company and station_id=p_station and period_start=to_date(p_month,'YYYY-MM')
       and period_end=(to_date(p_month,'YYYY-MM')+interval '1 month - 1 day')::date
     order by helper_id,revision desc) x;
 elsif p_scope like 'people:%' then
   v_run:=substring(p_scope from 8)::uuid;
   if not exists(select 1 from public.hr_payroll_runs where company_id=p_company and id=v_run and to_char(period_start,'YYYY-MM')=p_month)
   then raise exception 'Payroll run and salary month do not match.'; end if;
   v_payroll:=public.payment_release_payroll_snapshot(p_company,v_run,p_station);
   select coalesce(jsonb_agg(to_jsonb(d) order by d.recovery_key),'[]'::jsonb) into v_due
   from public.nl_loss_recovery_due(p_company,p_month,'hrms',v_run) d
   where d.employee_ref in (select v->>'worker' from jsonb_array_elements(v_payroll) v);
   select coalesce(jsonb_agg(jsonb_build_object('reference',d->>'recovery_key','worker',d->>'full_name','amount',(d->>'amount')::numeric)),'[]'::jsonb)
   into v_missing from jsonb_array_elements(v_due) d
   where (select coalesce(sum((item->>'amount')::numeric),0) from jsonb_array_elements(v_payroll) pay
     cross join lateral jsonb_array_elements(pay->'items') item where pay->>'worker'=d->>'employee_ref'
       and item->>'code'='OPS_LOSS_RECOVERY' and item#>>'{metadata,recovery_key}'=d->>'recovery_key')<>(d->>'amount')::numeric;
 end if;
 v_hash:=md5(jsonb_build_object('company',p_company,'station',p_station,'month',p_month,'scope',p_scope,
    'cases',v_cases,'due',v_due,'payroll',v_payroll)::text);
 select case when e.action<>'revoke' and e.fingerprint=v_hash then jsonb_build_object('id',e.id,'actor',e.actor_name,'at',e.created_at,'mode',e.action,'reason',e.reason) end
 into v_approval from public.loss_payment_release_events e
 where e.company_id=p_company and e.station_id=p_station and e.salary_month=p_month and e.scope_key=p_scope
 order by e.created_at desc,e.id desc limit 1;
 return jsonb_build_object('fingerprint',v_hash,'station',v_code,'month',p_month,'sourceCount',jsonb_array_length(v_cases),
  'pendingCount',jsonb_array_length(v_pending),'pendingAmount',(select coalesce(sum((v->>'amount')::numeric),0) from jsonb_array_elements(v_pending) v),
  'missingDeductionCount',jsonb_array_length(v_missing),'missingDeductionAmount',(select coalesce(sum((v->>'amount')::numeric),0) from jsonb_array_elements(v_missing) v),
  'pending',coalesce((select jsonb_agg(jsonb_build_object('report',v->>'report','month',v->>'month','reference',v->>'reference','amount',v->'amount','status',v->>'status')) from jsonb_array_elements(v_pending) v),'[]'::jsonb),
  'missingDeductions',v_missing,'approval',v_approval);
end $$;
