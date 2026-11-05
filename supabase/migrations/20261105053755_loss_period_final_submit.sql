-- Final submission locks manual loss changes, not source refreshes or payroll settlement.
create table if not exists public.nl_loss_period_closures (
 company_id uuid not null,
 report text not null check (report in ('nl','slp')),
 period text not null check (length(period) between 1 and 200),
 station_code text not null,
 closed_at timestamptz not null default now(),
 closed_by uuid not null,
 closed_by_name text not null,
 snapshot jsonb not null,
 primary key (company_id,report,period,station_code)
);
alter table public.nl_loss_period_closures enable row level security;
revoke all on public.nl_loss_period_closures from public,anon,authenticated,service_role;
grant select on public.nl_loss_period_closures to service_role;

create or replace function public.nl_loss_assert_period_open(p_company uuid,p_month text,p_case text)
returns void language plpgsql security definer set search_path='' as $$
declare c public.nl_loss_month_cases;
begin
 -- Use the same lock as plan writes, so closing and saving cannot race.
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 select * into c from public.nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case;
 if exists(select 1 from public.nl_loss_period_closures l where l.company_id=p_company
   and ((l.report=c.report and l.station_code=c.station_code
     and l.period=case when c.report='slp' then coalesce(nullif(c.details->>'period',''),c.month) else c.month end)
    or l.snapshot->'case_keys' ? (p_month||'|'||p_case))) then
  raise exception 'This loss period is finally submitted and closed. Changes are no longer allowed.';
 end if;
end $$;
revoke all on function public.nl_loss_assert_period_open(uuid,text,text) from public,anon,authenticated;
grant execute on function public.nl_loss_assert_period_open(uuid,text,text) to service_role;

create or replace function public.nl_loss_close_period(p_company uuid,p_report text,p_period text,p_stations text[],p_actor uuid,p_name text)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if p_report is null or p_report not in ('nl','slp') or nullif(trim(p_period),'') is null or length(p_period)>200
   or p_actor is null or nullif(trim(p_name),'') is null or coalesce(cardinality(p_stations),0)=0 then
  raise exception 'Choose one NL or SLP period and its stations.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
 insert into public.nl_loss_period_closures(company_id,report,period,station_code,closed_by,closed_by_name,snapshot)
 select p_company,p_report,p_period,c.station_code,p_actor,p_name,
   jsonb_build_object('shipments',count(*),'source_value',sum(c.amount),'case_keys',jsonb_agg(c.month||'|'||c.case_key),
     'recovery_plans',coalesce(jsonb_agg(to_jsonb(r)) filter(where r.case_key is not null),'[]'::jsonb))
 from public.nl_loss_month_cases c left join public.nl_loss_recoveries r
   on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key and not r.is_deleted
 where c.company_id=p_company and c.report=p_report and c.station_code=any(p_stations)
   and (case when c.report='slp' then coalesce(nullif(c.details->>'period',''),c.month) else c.month end)=p_period
 group by c.station_code
 on conflict do nothing;
 get diagnostics n = row_count;
 if n=0 and not exists(select 1 from public.nl_loss_period_closures where company_id=p_company
   and report=p_report and period=p_period and station_code=any(p_stations)) then
  raise exception 'No loss records exist for this period and station selection.';
 end if;
 return n;
end $$;
revoke all on function public.nl_loss_close_period(uuid,text,text,text[],uuid,text) from public,anon,authenticated;
grant execute on function public.nl_loss_close_period(uuid,text,text,text[],uuid,text) to service_role;

-- Guard every manual write entry point, including workbook uploads and legacy endpoints.
-- Keep original signatures, bodies and grants; source imports/payroll functions are untouched.
do $$
declare f record; definition text; guarded integer:=0;
begin
 for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['save_nl_recovery','clear_nl_recovery',
   'nl_loss_exception_set','nl_loss_lifecycle_transition','nl_loss_recovery_approve',
   'nl_redispute_transition','nl_redispute_track','nl_case_response_transition',
   'save_nl_dispute_request','waive_nl_recovery_balance']) loop
  definition:=pg_get_functiondef(f.oid);
  if position('public.nl_loss_assert_period_open(p_company,p_month,p_case)' in definition)=0 then
   definition:=regexp_replace(definition,'\mbegin\M',E'begin\n perform public.nl_loss_assert_period_open(p_company,p_month,p_case);','i');
   if position('public.nl_loss_assert_period_open(p_company,p_month,p_case)' in definition)=0 then
    raise exception 'Cannot protect loss write function %',f.proname;
   end if;
   execute definition;
  end if;
  guarded:=guarded+1;
 end loop;
 if guarded<>10 then raise exception 'Expected 10 loss write functions; found %',guarded; end if;
end $$;
